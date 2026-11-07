/**
 * BZENITAL Issue Reporter — Cloudflare Worker
 *
 * Configure the encrypted GITHUB_TOKEN secret with Issues: Read and Write access.
 * GITHUB_REPOSITORY optionally overrides the default TH0p/BZENITAL destination.
 * Deploy your own endpoint and configure it in BZENITAL; no shared endpoint is implied.
 * Public deployments must also configure abuse/rate limits in Cloudflare.
 */

const MAX_REQUEST_BYTES = 262144;
const MAX_DESCRIPTION_CHARS = 12000;
const MAX_LOG_CHARS = 48000;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const LABELS = Object.freeze({
  bug: ["bug", "diagnostics"],
  layout: ["visual/layout", "diagnostics"],
  performance: ["performance", "diagnostics"],
  enhancement: ["enhancement"],
});

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Count actual streamed bytes, including when Content-Length is omitted or incorrect.
async function readBody(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_REQUEST_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function validString(value, limit, required = false) {
  return typeof value === "string" && value.length <= limit && (!required || value.trim().length > 0);
}

export default {
  async fetch(request, env = {}) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return json({ error: "Content-Type must be application/json." }, 415);
    }

    let data;
    try {
      const text = await readBody(request);
      if (text === null) return json({ error: "Report exceeds the 256 KiB request limit." }, 413);
      data = JSON.parse(text);
    } catch (_) {
      return json({ error: "Invalid JSON report." }, 400);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return json({ error: "Report must be a JSON object." }, 400);
    }

    const { title, description, category = "bug", systemInfo = {}, logs = "" } = data;
    const systemFields = ["zentralVersion", "zenVersion", "platform", "windowSize", "sidebarMode"];
    if (!validString(title, 240, true) || !validString(description, MAX_DESCRIPTION_CHARS, true) ||
        typeof category !== "string" || !Object.hasOwn(LABELS, category) ||
        !validString(logs, MAX_REQUEST_BYTES) || !systemInfo || typeof systemInfo !== "object" ||
        Array.isArray(systemInfo) || systemFields.some(key => systemInfo[key] !== undefined && !validString(systemInfo[key], 200)) ||
        (systemInfo.dpr !== undefined && (typeof systemInfo.dpr !== "number" || !Number.isFinite(systemInfo.dpr) || systemInfo.dpr <= 0 || systemInfo.dpr > 100))) {
      return json({ error: "Invalid report fields or field length limit exceeded." }, 400);
    }

    const repository = env.GITHUB_REPOSITORY ?? "TH0p/BZENITAL";
    if (typeof env.GITHUB_TOKEN !== "string" || !env.GITHUB_TOKEN.trim() ||
        typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
        [".", ".."].includes(repository.split("/")[1])) {
      return json({ error: "Issue reporter is not configured." }, 503);
    }

    // Keep environment values on one line so they cannot inject Markdown sections.
    const info = (key, fallback = "Unknown") => (systemInfo[key] || fallback).replace(/[\r\n]/g, " ");
    let body = `### Description\n${description.trim()}\n\n`;
    body += "### Environment\n";
    body += `- **Zentral Version:** ${info("zentralVersion")}\n`;
    body += `- **Zen Build:** ${info("zenVersion")}\n`;
    body += `- **OS / Platform:** ${info("platform")}\n`;
    body += `- **Window / DPR:** ${info("windowSize")} (DPR: ${systemInfo.dpr || 1})\n`;
    body += `- **Sidebar Layout:** ${info("sidebarMode", "Vertical")}\n\n`;
    if (logs.trim()) {
      let processedLogs = logs.trim();
      // Protect the log code block from embedded fences before applying the final limit.
      processedLogs = processedLogs.replace(/```/g, "``\u200b`");
      if (processedLogs.length > MAX_LOG_CHARS) {
        processedLogs = processedLogs.slice(0, 12000) + "\n\n... [Log truncated: initial snapshot and most recent events preserved] ...\n\n" + processedLogs.slice(-35000);
      }
      const lineCount = processedLogs.split("\n").length;
      body += `<details>\n<summary>Diagnostic Log (${lineCount} lines)</summary>\n\n\`\`\`text\n${processedLogs}\n\`\`\`\n</details>\n`;
    }
    // All variable-sized fields above are bounded, including description and environment.
    if (body.length > 65536) return json({ error: "Formatted report exceeds the issue body limit." }, 400);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/issues`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GITHUB_TOKEN.trim()}`,
          "User-Agent": "BZENITAL-Issue-Reporter",
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: `[${category.toUpperCase()}] ${title.trim()}`, body, labels: LABELS[category] }),
        signal: controller.signal,
      });
      if (!response.ok) return json({ error: "GitHub could not create the issue.", status: response.status }, 502);
      const result = await response.json();
      if (!Number.isSafeInteger(result?.number) || result.number <= 0 || typeof result.html_url !== "string") {
        return json({ error: "GitHub returned an invalid issue response." }, 502);
      }
      return json({ success: true, issueNumber: result.number, issueUrl: result.html_url });
    } catch (_) {
      return json({ error: "GitHub issue service is unavailable. Please try again later." }, 502);
    } finally {
      clearTimeout(timeout);
    }
  },
};
