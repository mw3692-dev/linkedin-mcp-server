import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// --- Prompt content ---

const LINKEDIN_PROMPT = `# LinkedIn Post Drafter

You help the user draft LinkedIn posts that are professional but conversational — the kind that sound like a smart colleague sharing an insight over coffee, not a corporate press release. After drafting, you load the post directly into LinkedIn's composer so it's ready to review and publish.

## How to use this skill

The user gives you a topic, idea, accomplishment, observation, or article — and you turn it into a ready-to-publish LinkedIn post.

If the user doesn't specify a style, default to **thought leadership** (see styles below). If the topic naturally fits a different style, suggest it but go with what feels right.

## Post styles

### Thought leadership
Share a perspective, insight, or contrarian take on an industry topic. Lead with a hook — a surprising claim, a question, or a bold statement. Follow with 2-3 sentences of reasoning or evidence. End with a question or invitation to discuss.

**Example structure:**
\`\`\`
[Bold opening hook — 1 line that stops the scroll]

[2-3 sentences expanding on the insight, with a concrete example or data point]

[Closing question or call to engage]

[hashtags]
\`\`\`

### Storytelling
A brief personal anecdote that leads to a professional insight. The story should be specific (names, numbers, moments) but concise. The lesson should feel earned, not preachy.

**Example structure:**
\`\`\`
[Set the scene in 1-2 sentences]

[What happened — the twist, surprise, or realization]

[The takeaway, stated simply]

[hashtags]
\`\`\`

### Tips / Listicle
3-5 actionable tips on a specific topic. Each tip should be one line, maybe two. Use line breaks and numbering for scannability. The intro should be one sentence that frames why these tips matter.

**Example structure:**
\`\`\`
[One-line intro framing the problem or opportunity]

1. [Tip] — [brief why]
2. [Tip] — [brief why]
3. [Tip] — [brief why]

[One-line closing or CTA]

[hashtags]
\`\`\`

### Announcement
Sharing news — a new role, project launch, milestone, or event. Keep it genuine and specific. Avoid corporate-speak. Thank people by name when appropriate.

**Example structure:**
\`\`\`
[The news, stated clearly]

[Why it matters to you / what's exciting about it]

[Thank-you or forward-looking statement]

[hashtags]
\`\`\`

## Voice and formatting guidelines

**Tone:** Professional but human. Write like you're explaining something to a peer you respect — not pitching, not lecturing. Confidence without arrogance. Specificity over vagueness.

**Length:** Keep it short. 1-3 short paragraphs. LinkedIn posts that perform well are scannable — use line breaks generously. Every sentence should earn its spot.

**Formatting rules:**
- Use single line breaks between thoughts for readability (LinkedIn compresses paragraphs, so whitespace helps)
- LinkedIn's composer does NOT support markdown bold/italic — do not use **text** or *text* in the final post. Use UPPERCASE for emphasis sparingly if needed, or just let the words speak for themselves.
- No bullet points in thought leadership or storytelling; fine in tips/listicles
- Emojis: use 0-2 max, and only if they add meaning (e.g., a rocket for a launch). Never use emojis as bullet points or decoration

**Hashtags:** Add 3-5 relevant hashtags at the end. Mix broad (#Leadership, #Tech) with specific (#DevTools, #AIEngineering). Lowercase or CamelCase, whatever reads better.

**What to avoid:**
- "I'm thrilled to announce..." (overused, sounds corporate)
- "Let that sink in." (cliche)
- Starting with "So," or "Here's the thing:"
- Engagement bait ("Like if you agree!", "Comment your thoughts below!")
- Walls of text with no line breaks
- Humble-bragging disguised as lessons
- Generic advice that could apply to anything ("Work hard and be kind")

## The user's context

The user works in tech/software. When they give a vague topic, lean toward angles relevant to engineering, product, AI, startups, or technical leadership. But follow their lead — if they give a topic outside tech, write for that domain instead.

## Workflow

1. Draft the post based on the user's topic. Show it in chat for review.
2. Once approved, use the \`load-linkedin-post\` tool to get the composer injection code.
3. Use browser automation (Claude in Chrome) to navigate to LinkedIn and execute the injection code.
4. Tell the user their post is loaded and ready to review/publish.

If the user's topic is ambiguous, ask one clarifying question before drafting rather than guessing wrong.`;

// --- Factory: create a configured McpServer ---

function createServer(): McpServer {
  const server = new McpServer({
    name: "linkedin-post",
    version: "1.0.0",
  });

  server.prompt(
    "linkedin-post",
    "Draft a LinkedIn post from a topic or idea. Supports thought leadership, storytelling, tips/listicle, and announcement styles.",
    { topic: z.string().describe("The topic, idea, or content to turn into a LinkedIn post").optional() },
    ({ topic }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: topic
              ? `${LINKEDIN_PROMPT}\n\n---\n\nPlease draft a LinkedIn post about: ${topic}`
              : LINKEDIN_PROMPT,
          },
        },
      ],
    })
  );

  server.tool(
    "load-linkedin-post",
    "Generate the JavaScript code to inject a LinkedIn post into the composer. Returns JS that should be executed in the browser via Claude in Chrome's javascript_tool on the LinkedIn feed page.",
    { paragraphs: z.array(z.string()).describe("Array of paragraph strings to load into the LinkedIn composer") },
    ({ paragraphs }) => {
      const escaped = paragraphs.map((p) => p.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n"));

      const js = `// Find the editor inside LinkedIn's shadow DOM
const all = document.querySelectorAll('*');
let editor = null;
for (const el of all) {
  if (el.shadowRoot) {
    const e = el.shadowRoot.querySelector('.ql-editor');
    if (e) { editor = e; break; }
  }
}

if (editor) {
  const paragraphs = [${escaped.map((p) => `'${p}'`).join(", ")}];

  let html = '';
  for (let i = 0; i < paragraphs.length; i++) {
    html += '<p>' + paragraphs[i] + '</p>';
    if (i < paragraphs.length - 1) {
      html += '<p><br></p>';
    }
  }

  editor.innerHTML = html;
  editor.classList.remove('ql-blank');
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  'Post loaded into composer successfully';
} else {
  'Error: Could not find LinkedIn composer editor. Make sure the composer modal is open.';
}`;

      return {
        content: [
          {
            type: "text" as const,
            text: `Execute this JavaScript in the browser on the LinkedIn feed page (after opening the composer modal):\n\n\`\`\`javascript\n${js}\n\`\`\``,
          },
        ],
      };
    }
  );

  return server;
}

// --- HTTP Server ---

const app = express();
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId) {
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "Session not found" });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } else {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });
    const mcpServer = createServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
    if (transport.sessionId) {
      transports.set(transport.sessionId, transport);
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({ error: "No active session" });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({ error: "No active session" });
    return;
  }
  await transport.handleRequest(req, res);
  if (transport.sessionId) transports.delete(transport.sessionId);
});

const PORT = parseInt(process.env.PORT || "3847", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`LinkedIn MCP server running on http://0.0.0.0:${PORT}/mcp`);
});
