/**
 * CFData-WEB 专用多源 TXT 聚合与清洗服务 (v2.0 纯 /admin KV 驱动归档版)
 *
 * 环境变量与绑定说明：
 * - [必选] KV 命名空间绑定：变量名必须为 TXT_KV
 * - [可选] 环境变量 ADMIN_PWD：/admin 网页后台的管理密码
 * - [可选] 环境变量 TOKEN：拉取订阅时的鉴权 Token（访问需带 ?token=xxx）
 */

const FETCH_TIMEOUT_MS = 6000; // 单源读取全链路最大超时（毫秒）
const CACHE_TTL_SEC = 300;     // 默认边缘缓存时间（秒）
const KV_KEY = "TXT_SOURCES_CONFIG";

// 跨域响应头（确保 CFData-WEB 在浏览器端拉取不被拦截）
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With"
};

export default {
  async fetch(request, env) {
    // 1. 处理浏览器 CORS 预检请求
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 2. 路由：可视化管理面板 (/admin)
    if (path === "/admin") {
      return handleAdmin(request, env);
    }

    // 3. 可选：订阅拉取 Token 鉴权（如果设置了环境变量 TOKEN）
    if (env.TOKEN && url.searchParams.get("token") !== env.TOKEN) {
      return new Response("Unauthorized: Invalid token", {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    // 4. 强制检查 KV 绑定状态与读取配置
    if (!env.TXT_KV) {
      return new Response("错误：未绑定 TXT_KV 命名空间！请先在 Worker 设置中绑定 KV，然后访问 /admin 添加数据源。", {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const rawConfig = await getRawConfig(env);
    const parsedSources = parseConfig(rawConfig);

    // 如果 /admin 中还没有配置任何有效源，直接返回空文本或提示
    if (parsedSources.length === 0) {
      if (path === "/status" || url.searchParams.has("status")) {
        return new Response("当前未配置任何数据源，请访问 /admin 粘贴 TXT 链接并保存。", {
          headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" }
        });
      }
      return new Response("", {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
          "X-Active-Sources": "0",
          "X-Unique-Nodes": "0"
        }
      });
    }

    // 5. 解析 URL 过滤参数
    const includeTags = parseParamList(url.searchParams.get("tag"));
    const excludeTags = parseParamList(url.searchParams.get("exclude"));
    const typeFilter = parseParamList(url.searchParams.get("type")); // ipv4, ipv6, domain, cidr
    const forceNoCache = url.searchParams.has("nocache");
    const autoTag = url.searchParams.get("autotag") !== "0"; // 默认开启自动补标签，传 autotag=0 关闭
    const prefixTag = url.searchParams.get("prefix_tag") === "1"; // 是否给已有备注也加上 [TAG] 前缀
    const normPort = url.searchParams.get("norm_port") === "1"; // 是否将 :443 与无端口视为同一地址去重
    const globalLimit = parseInt(url.searchParams.get("limit") || "0", 10);
    const globalShuffle = url.searchParams.get("shuffle") === "1";

    const activeSources = parsedSources.filter(src => {
      if (includeTags.length > 0 && !includeTags.includes(src.tag)) return false;
      if (excludeTags.length > 0 && excludeTags.includes(src.tag)) return false;
      return true;
    });

    // 6. 并发拉取所有目标源
    const fetchResults = await Promise.all(
      activeSources.map(src => fetchSingleSource(src, forceNoCache))
    );

    // 7. 路由：健康检查报告 (/status 或 ?status=1)
    if (path === "/status" || url.searchParams.has("status")) {
      return new Response(
        buildStatusReport(fetchResults, activeSources.length, parsedSources.length),
        { headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    // 8. 合并、过滤、单源限流与智能去重
    const uniqueNodes = new Map();

    for (const res of fetchResults) {
      if (!res.ok || !res.validLines) continue;

      let lines = res.validLines;
      if (typeFilter.length > 0) {
        lines = lines.filter(item => typeFilter.includes(item.type.toUpperCase()));
      }

      if (res.limitMode === "random" && res.limitCount > 0 && lines.length > res.limitCount) {
        lines = shuffleArray([...lines]).slice(0, res.limitCount);
      } else if (res.limitMode === "head" && res.limitCount > 0 && lines.length > res.limitCount) {
        lines = lines.slice(0, res.limitCount);
      }

      for (const item of lines) {
        const dedupKey = getDedupKey(item, normPort);
        const formattedLine = formatNodeLine(item, res.tag, autoTag, prefixTag);
        const existing = uniqueNodes.get(dedupKey);

        if (!existing) {
          uniqueNodes.set(dedupKey, {
            line: formattedLine,
            hasOriginalRemark: item.hasRemark
          });
        } else if (!existing.hasOriginalRemark && item.hasRemark) {
          uniqueNodes.set(dedupKey, {
            line: formattedLine,
            hasOriginalRemark: true
          });
        }
      }
    }

    let finalLines = Array.from(uniqueNodes.values()).map(v => v.line);

    if (globalShuffle) {
      finalLines = shuffleArray(finalLines);
    }
    if (globalLimit > 0 && finalLines.length > globalLimit) {
      finalLines = finalLines.slice(0, globalLimit);
    }

    return new Response(finalLines.join("\n"), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": forceNoCache ? "no-store" : `public, max-age=${CACHE_TTL_SEC}`,
        "X-Active-Sources": `${activeSources.length}`,
        "X-Unique-Nodes": `${finalLines.length}`
      }
    });
  }
};

/**
 * 仅从 KV 数据库读取配置，无任何内置默认源
 */
async function getRawConfig(env) {
  if (!env.TXT_KV) return "";
  const kvData = await env.TXT_KV.get(KV_KEY);
  return kvData || "";
}

/**
 * 解析配置文本，支持格式：
 * https://example.com/a.txt @JP *100
 */
function parseConfig(rawText) {
  const sourcesMap = new Map();
  const lines = rawText.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    const tokens = line.split(/\s+/);
    const targetUrl = tokens[0];
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) continue;

    let tag = "DEFAULT";
    let limitMode = "none";
    let limitCount = 0;

    for (let i = 1; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk.startsWith("#") || tk.startsWith("//")) break;
      if (tk.startsWith("@") && tk.length > 1) {
        tag = tk.slice(1).toUpperCase();
      } else if (tk.startsWith("*") && /^\*\d+$/.test(tk)) {
        limitMode = "random";
        limitCount = parseInt(tk.slice(1), 10);
      } else if (tk.startsWith("+") && /^\+\d+$/.test(tk)) {
        limitMode = "head";
        limitCount = parseInt(tk.slice(1), 10);
      }
    }

    if (!sourcesMap.has(targetUrl)) {
      sourcesMap.set(targetUrl, { url: targetUrl, tag, limitMode, limitCount });
    }
  }
  return Array.from(sourcesMap.values());
}

/**
 * 拉取单个上游数据源（全链路超时控制 + 强制边缘缓存 + 防污染清洗）
 */
async function fetchSingleSource(source, forceNoCache) {
  const startTime = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(source.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/plain, */*"
      },
      signal: controller.signal,
      cf: forceNoCache
        ? { cacheTtl: 0, cacheEverything: false }
        : { cacheTtl: CACHE_TTL_SEC, cacheEverything: true }
    });

    if (!response.ok) {
      const costMs = Date.now() - startTime;
      return { ...source, ok: false, status: response.status, costMs, error: `HTTP ${response.status}` };
    }

    const rawText = await response.text();
    const costMs = Date.now() - startTime;
    const trimmed = rawText.replace(/^\uFEFF/, "").trim();

    const headSample = trimmed.slice(0, 200).toLowerCase();
    if (
      headSample.startsWith("<!doctype") ||
      headSample.startsWith("<html") ||
      headSample.startsWith("<head") ||
      headSample.startsWith("<body") ||
      headSample.startsWith("{") ||
      headSample.includes("<script")
    ) {
      return { ...source, ok: false, status: 200, costMs, error: "内容疑似 HTML/JSON 网页，已自动拦截防污染" };
    }

    const validLines = [];
    for (let line of trimmed.split(/\r?\n/)) {
      line = line.replace(/^\uFEFF/, "").trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;

      const hashIndex = line.indexOf("#");
      const rawAddrPart = (hashIndex === -1 ? line : line.slice(0, hashIndex)).trim();
      const remarkPart = hashIndex === -1 ? "" : line.slice(hashIndex + 1).trim();

      const normalizedAddr = normalizeRawAddress(rawAddrPart);
      const parsed = classifyAddress(normalizedAddr);

      if (parsed.valid) {
        validLines.push({
          coreAddr: parsed.normalized,
          host: parsed.host,
          port: parsed.port,
          type: parsed.type,
          remark: remarkPart,
          hasRemark: remarkPart.length > 0
        });
      }
    }

    return { ...source, ok: true, status: 200, costMs, validLines, count: validLines.length };
  } catch (err) {
    const costMs = Date.now() - startTime;
    const isTimeout = err.name === "AbortError";
    return {
      ...source,
      ok: false,
      status: 0,
      costMs,
      error: isTimeout ? `读取超时 (超过 ${FETCH_TIMEOUT_MS}ms)` : (err.message || "网络异常")
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRawAddress(raw) {
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.length >= 2 && /^\d{1,5}$/.test(parts[1])) {
    const host = parts[0];
    const port = parts[1];
    if (host.includes(":") && !host.startsWith("[")) {
      return `[${host}]:${port}`;
    }
    return `${host}:${port}`;
  }
  return parts[0] || "";
}

function classifyAddress(addr) {
  if (!addr || addr.length > 253) return { valid: false };
  if (/[<>"{}|\\^`\s;]/.test(addr)) return { valid: false };

  if (addr.includes("/")) {
    const [net, maskStr] = addr.split("/");
    const mask = Number(maskStr);
    if (!Number.isInteger(mask) || mask < 1 || mask > 128) return { valid: false };
    const baseCheck = classifyAddress(net);
    if (baseCheck.valid && (baseCheck.type === "ipv4" || baseCheck.type === "ipv6")) {
      return { valid: true, type: "cidr", host: baseCheck.host, port: "", normalized: `${baseCheck.host}/${mask}` };
    }
    return { valid: false };
  }

  if (addr.startsWith("[")) {
    const match = addr.match(/^\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?$/);
    if (!match) return { valid: false };
    const host = match[1].toLowerCase();
    const port = match[2] || "";
    if (port && !isValidPort(port)) return { valid: false };
    if (!isValidIPv6(host)) return { valid: false };
    return {
      valid: true,
      type: "ipv6",
      host,
      port,
      normalized: port ? `[${host}]:${port}` : host
    };
  }

  const colonCount = (addr.match(/:/g) || []).length;
  if (colonCount >= 2) {
    const host = addr.toLowerCase();
    if (!isValidIPv6(host)) return { valid: false };
    return { valid: true, type: "ipv6", host, port: "", normalized: host };
  }

  let host = addr;
  let port = "";
  if (colonCount === 1) {
    const [h, p] = addr.split(":");
    if (!isValidPort(p)) return { valid: false };
    host = h;
    port = p;
  }

  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    const octets = host.split(".").map(Number);
    if (octets.some(n => n < 0 || n > 255)) return { valid: false };
    return {
      valid: true,
      type: "ipv4",
      host,
      port,
      normalized: port ? `${host}:${port}` : host
    };
  }

  const lowerHost = host.toLowerCase();
  if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(lowerHost)) {
    return {
      valid: true,
      type: "domain",
      host: lowerHost,
      port,
      normalized: port ? `${lowerHost}:${port}` : lowerHost
    };
  }

  return { valid: false };
}

function isValidPort(portStr) {
  const p = Number(portStr);
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

function isValidIPv6(host) {
  return /^[0-9a-f:]+$/i.test(host) && host.includes(":") && !host.includes(":::");
}

function getDedupKey(item, normPort) {
  if (normPort && (item.port === "" || item.port === "443")) {
    return `${item.host.toLowerCase()}:443_norm`;
  }
  return item.coreAddr.toLowerCase();
}

function formatNodeLine(item, sourceTag, autoTag, prefixTag) {
  const validTag = sourceTag && sourceTag !== "DEFAULT" ? sourceTag : "";
  if (item.hasRemark) {
    if (prefixTag && validTag && !item.remark.toUpperCase().includes(validTag)) {
      return `${item.coreAddr}#[${validTag}] ${item.remark}`;
    }
    return `${item.coreAddr}#${item.remark}`;
  }
  if (autoTag && validTag) {
    return `${item.coreAddr}#${validTag}`;
  }
  return item.coreAddr;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseParamList(param) {
  if (!param) return [];
  return param.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildStatusReport(results, activeCount, totalCount) {
  let report = `=== CFData-WEB 聚合源健康诊断报告 ===\n`;
  report += `检查时间: ${new Date().toISOString()}\n`;
  report += `启用源数: ${activeCount} / 总配置源数: ${totalCount} (单次最多支持 49 个上游源)\n`;
  report += `------------------------------------------------------------\n\n`;

  let totalRawNodes = 0;
  for (const r of results) {
    const limitInfo = r.limitMode === "random"
      ? ` [随机抽样:${r.limitCount}]`
      : r.limitMode === "head"
        ? ` [截取前:${r.limitCount}]`
        : "";
    if (r.ok) {
      totalRawNodes += r.count;
      report += `[正常] [${r.tag}]${limitInfo} (${r.costMs}ms) -> 有效节点: ${r.count} 条\n  └─ ${r.url}\n`;
    } else {
      report += `[失败] [${r.tag}]${limitInfo} (${r.costMs}ms) -> 原因: ${r.error}\n  └─ ${r.url}\n`;
    }
  }

  report += `\n------------------------------------------------------------\n`;
  report += `去重前有效节点总计: ${totalRawNodes} 条\n`;
  return report;
}

/**
 * 处理 /admin 网页管理面板及在线测试/保存 API
 */
async function handleAdmin(request, env) {
  const needPwd = Boolean(env.ADMIN_PWD);

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (needPwd && body.pwd !== env.ADMIN_PWD) {
      return new Response("管理密码错误！", { status: 403 });
    }

    if (body.action === "load") {
      const cfg = await getRawConfig(env);
      return new Response(cfg, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (body.action === "test") {
      const sources = parseConfig(body.config || "");
      if (sources.length === 0) {
        return new Response("编辑器中未检测到任何有效的 http/https 链接！", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      const results = await Promise.all(sources.map(src => fetchSingleSource(src, true)));
      const report = buildStatusReport(results, sources.length, sources.length);
      return new Response(report, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (!env.TXT_KV) {
      return new Response("未绑定 TXT_KV 命名空间，无法保存！请先在 Worker 设置中绑定 KV。", { status: 400 });
    }
    await env.TXT_KV.put(KV_KEY, body.config || "");
    return new Response("保存成功！新配置已立即生效。");
  }

  const initialConfig = needPwd ? "# 已启用密码保护，请在下方输入密码后点击「读取配置」解锁..." : await getRawConfig(env);
  const kvBound = Boolean(env.TXT_KV);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>CFData-WEB 聚合源管理面板</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; max-width: 900px; margin: 25px auto; padding: 0 20px; }
    h2 { margin-bottom: 10px; color: #f8fafc; }
    .tip { font-size: 13px; color: #94a3b8; line-height: 1.7; background: #1e293b; padding: 14px 16px; border-radius: 8px; margin-bottom: 14px; border: 1px solid #334155; }
    code { background: #0f172a; color: #38bdf8; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    textarea { width: 100%; height: 360px; background: #090d16; color: #4ade80; border: 1px solid #334155; border-radius: 8px; padding: 12px; font-family: Consolas, monospace; font-size: 13.5px; box-sizing: border-box; line-height: 1.5; }
    .bar { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; align-items: center; }
    input { background: #1e293b; color: #fff; border: 1px solid #475569; padding: 9px 12px; border-radius: 6px; min-width: 220px; }
    button { background: #2563eb; color: #fff; border: none; padding: 9px 18px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13.5px; }
    button:hover { background: #1d4ed8; }
    button.sec { background: #475569; }
    button.sec:hover { background: #334155; }
    pre { background: #090d16; color: #cbd5e1; padding: 14px; border-radius: 8px; border: 1px solid #334155; font-size: 12.5px; overflow-x: auto; white-space: pre-wrap; margin-top: 16px; display: none; }
  </style>
</head>
<body>
  <h2>CFData-WEB 数据源聚合管理</h2>
  <div class="tip">
    1. <b>语法规则</b>：每行粘贴一个 TXT 链接，支持 <code>#</code> 注释停用；空格后可加 <code>@标签</code> 分类；再加 <code>*100</code> 表示随机抽 100 条（或 <code>+100</code> 取前 100 条）。<br>
    2. <b>示例写法</b>：<code>https://bestcf.pages.dev/random-region/JP/all.txt @JP *150</code><br>
    3. <b>KV 绑定状态</b>：${kvBound ? '<span style="color:#4ade80;font-weight:bold;">已绑定 TXT_KV (所见即所得，保存立即生效)</span>' : '<span style="color:#f87171;font-weight:bold;">未绑定 TXT_KV (必须先在 Worker 设置中绑定 TXT_KV 才能使用！)</span>'}
  </div>
  <textarea id="cfg" spellcheck="false" placeholder="在此处粘贴你的 TXT 数据源链接（每行一个）...">${escapeHtml(initialConfig)}</textarea>
  <div class="bar">
    <input type="password" id="pwd" placeholder="管理密码 (未设 ADMIN_PWD 留空)">
    ${needPwd ? '<button class="sec" onclick="loadCfg()">读取配置</button>' : ''}
    <button onclick="saveCfg()">保存配置</button>
    <button class="sec" onclick="testCfg()">在线测试当前源状态</button>
  </div>
  <pre id="report"></pre>
  <script>
    async function postAction(action) {
      const res = await fetch('/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          config: document.getElementById('cfg').value,
          pwd: document.getElementById('pwd').value
        })
      });
      return { ok: res.ok, text: await res.text() };
    }
    async function loadCfg() {
      const r = await postAction('load');
      if (r.ok) document.getElementById('cfg').value = r.text;
      else alert(r.text);
    }
    async function saveCfg() {
      const r = await postAction('save');
      alert(r.text);
    }
    async function testCfg() {
      const box = document.getElementById('report');
      box.style.display = 'block';
      box.textContent = '正在并发拉取并校验编辑器中的所有数据源，请稍候...';
      const r = await postAction('test');
      box.textContent = r.text;
    }
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}