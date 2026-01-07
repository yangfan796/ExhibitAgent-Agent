import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import cors from "cors";

// ================= 基础服务 =================
const app = express();
app.use(cors({ origin: "*"}));
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ================= 通义配置 =================
const TONGYI_API_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const TONGYI_MODEL = process.env.TONGYI_MODEL || "qwen-plus";

// ================= Agent 系统 Prompt =================
const SYSTEM_PROMPT = `你是一个【展会信息与策划聊天式 Agent】。

你的目标：
- 像一个真实的人类助理一样与用户自然对话
- 帮助用户逐步明确展会相关需求
- 在合适的时机提供专业、可执行的信息

对话规则：
1. 默认使用自然、口语但专业的中文
2. 可以寒暄、解释、追问
3. 信息不完整时，主动提问澄清
4. 不编造不存在的展会
5. 不确定要明确说“不确定”

结构化输出规则：
- 只有在用户明确要求「整理 / 清单 / 表格 / JSON / 结构化」
  或你判断结构化明显更有用时，才输出 JSON
- 输出 JSON 时：
  - 先用自然语言说明
  - 然后单独输出一个 JSON（不要 Markdown）
  - JSON 外不夹杂多余文本

JSON 结构（需要时）：
{
  "events": [
    {
      "name": "",
      "date": "",
      "city": "",
      "venue": "",
      "organizer": "",
      "website": "",
      "description": ""
    }
  ],
  "next_step": ""
}

输出语言：中文`;

// ================= 会话内存 =================
const sessions = new Map();
// key: ws  value: messages[]

// ================= 调用通义 =================
async function tongyiStream(ws, messages, keyOverride) {
  const key = keyOverride || process.env.DASHSCOPE_API_KEY;
  if (!key) return "❌ 未配置通义 API Key，请设置环境变量 DASHSCOPE_API_KEY。";
  const client = new OpenAI({ apiKey: key, baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
  const stream = await client.chat.completions.create({ model: TONGYI_MODEL, messages, stream: true, stream_options: { include_usage: true } });
  let full = "";
  for await (const chunk of stream) {
    const delta = chunk?.choices?.[0]?.delta?.content || "";
    if (delta) {
      full += delta;
      ws.send(JSON.stringify({ role: "assistant", type: "delta", content: delta }));
    }
  }
  return full.trim();
}

// ================= 简单意图识别 =================
function detectIntent(text) {
  const t = String(text || "").toLowerCase();
  const planKeywords = ["方案", "筹备", "规划", "计划", "举办", "办一个", "开一个", "策划"];
  const infoKeywords = ["有哪些", "有什么展", "展会信息", "时间", "地点", "官网", "主办", "参展"];
  const isPlan =
    planKeywords.some(k => t.includes(k)) && t.includes("展");
  const isInfo =
    infoKeywords.some(k => t.includes(k)) || /展会|博览会|大会/.test(t);
  if (isPlan && !t.includes("查询")) return "plan";
  if (isInfo && !isPlan) return "info";
  return "auto";
}

// ================= HTTP SSE =================
app.post("/api/chat-stream", async (req, res) => {
  const text = String(req.body?.text || "");
  const keyOverride = typeof req.body?.key === "string" ? req.body.key : undefined;
  const session = [{ role: "system", content: SYSTEM_PROMPT }];
  const intent = detectIntent(text);
  session.push({ role: "user", content: text });
  const wantsTable = /表格|清单|列表|excel|csv|结构化|整理成表格|导出/i.test(text);
  if (intent !== "plan") {
    if (wantsTable) {
      session.push({
        role: "user",
        content:
          "请用中文自然说明，并给出一个Markdown表格，不要JSON。表格列：名称|时间|城市|地点|主办|官网|简介。若信息不全，请在表格后给出建议与下一步。",
      });
    } else {
      session.push({
        role: "user",
        content:
          "请以中文自然说明为主，不要输出JSON或表格；必要时可在文案中附上官网链接。",
      });
    }
  } else {
    session.push({
      role: "user",
      content:
        "当前意图是“筹办动漫展会的可执行方案”。请以自然语言输出，包含：目标与定位、主题与受众、时间与规模、预算拆分、场地与动线、展商与赞助、内容策划（日程/舞台/嘉宾）、票务与权益、宣发渠道与节奏、人员组织与SOP、风险与预案、里程碑时间表（倒排）。如需再细化，可在结尾给出3条高价值下一步建议。",
    });
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const key = keyOverride || process.env.DASHSCOPE_API_KEY;
  if (!key) {
    res.write(`data: ${JSON.stringify({ error: "未配置通义密钥" })}\n\n`);
    return res.end();
  }
  try {
    const client = new OpenAI({ apiKey: key, baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
    const stream = await client.chat.completions.create({ model: TONGYI_MODEL, messages: session, stream: true, stream_options: { include_usage: true } });
    let full = "";
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || "";
      if (delta) {
        full += delta;
        res.write(`data: ${delta}\n\n`);
      }
    }
    res.write(`data: [FINAL]\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: String(e?.message || e) })}\n\n`);
    res.end();
  }
});

// ================= WebSocket =================
wss.on("connection", (ws) => {
  // 初始化会话
  sessions.set(ws, [{ role: "system", content: SYSTEM_PROMPT }]);

  ws.on("message", async (msg) => {
    let text = "";
    let keyOverride;

    try {
      const payload = JSON.parse(msg.toString());
      text = String(payload.text || "");
      keyOverride =
        typeof payload.key === "string" ? payload.key : undefined;
    } catch {
      text = msg.toString();
    }

    const history = sessions.get(ws);
    const intent = detectIntent(text);

    history.push({ role: "user", content: text });
    const wantsTable = /表格|清单|列表|excel|csv|结构化|整理成表格|导出/i.test(text);
    if (intent !== "plan") {
      if (wantsTable) {
        history.push({
          role: "user",
          content:
            "请用中文自然说明，并给出一个Markdown表格，不要JSON。表格列：名称|时间|城市|地点|主办|官网|简介。若信息不全，请在表格后给出建议与下一步。",
        });
      } else {
        history.push({
          role: "user",
          content:
            "请以中文自然说明为主，不要输出JSON或表格；必要时可在文案中附上官网链接。",
        });
      }
    } else {
      history.push({
        role: "user",
        content:
          "当前意图是“筹办动漫展会的可执行方案”。请以自然语言输出，包含：目标与定位、主题与受众、时间与规模、预算拆分、场地与动线、展商与赞助、内容策划（日程/舞台/嘉宾）、票务与权益、宣发渠道与节奏、人员组织与SOP、风险与预案、里程碑时间表（倒排）。如需再细化，可在结尾给出3条高价值下一步建议。",
      });
    }

    ws.send(
      JSON.stringify({
        role: "assistant",
        type: "status",
        content: "正在思考中…",
      })
    );

    const reply = await tongyiStream(ws, history, keyOverride);

    history.push({ role: "assistant", content: reply });

    // 控制上下文长度（很重要）
    if (history.length > 20) {
      sessions.set(ws, [
        history[0], // system
        ...history.slice(-18),
      ]);
    }

    ws.send(
      JSON.stringify({
        role: "assistant",
        type: "final",
        content: reply,
      })
    );
  });

  ws.on("close", () => {
    sessions.delete(ws);
  });
});

// ================= 启动 =================
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("✅ Server running at http://localhost:" + port);
});
