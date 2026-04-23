import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import fetch from "node-fetch";

// --- LinkedIn OAuth + API config ---

const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID || "";
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET || "";
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.BASE_URL || "http://localhost:3847";
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

// In-memory token store (persisted via env vars across deploys)
let accessToken = process.env.LINKEDIN_ACCESS_TOKEN || "";
let personUrn = process.env.LINKEDIN_PERSON_URN || "";

// --- Prompt content ---

const LINKEDIN_PROMPT = `# LinkedIn Post Drafter

You help the user draft LinkedIn posts that are professional but conversational — the kind that sound like a smart colleague sharing an insight over coffee, not a corporate press release. After drafting, you save the post directly to LinkedIn as a draft so the user can review and publish it.

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
2. Once approved, use the \`create-linkedin-draft\` tool to save it as a draft on LinkedIn.
3. Tell the user their draft is saved and they can find it in their LinkedIn drafts to review, edit, or publish.

If the user's topic is ambiguous, ask one clarifying question before drafting rather than guessing wrong.`;

// --- Factory: create a configured McpServer ---

function createServer(): McpServer {
  const server = new McpServer({
    name: "linkedin-post",
    version: "2.0.0",
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

  // --- Tool: Create LinkedIn Draft ---

  server.tool(
    "create-linkedin-draft",
    "Save a post as a draft on LinkedIn. The post will appear in the user's LinkedIn drafts for review and publishing. No browser required.",
    { content: z.string().describe("The full text of the LinkedIn post to save as a draft") },
    async ({ content }) => {
      if (!accessToken || !personUrn) {
        const loginUrl = `${BASE_URL}/auth/login`;
        return {
          content: [
            {
              type: "text" as const,
              text: `LinkedIn is not authenticated. Please visit this URL to connect your LinkedIn account:\n\n${loginUrl}\n\nAfter authorizing, try again.`,
            },
          ],
          isError: true,
        };
      }

      try {
        // Try creating as DRAFT first, fall back to PUBLISHED
        let lifecycleState = "DRAFT";
        let response = await createPost(content, lifecycleState);

        if (response.status === 422 || response.status === 400) {
          // DRAFT may not be supported for personal posts — fall back to PUBLISHED
          lifecycleState = "PUBLISHED";
          response = await createPost(content, lifecycleState);
        }

        if (response.status === 201) {
          const postId = response.headers.get("x-restli-id") || "unknown";
          const message =
            lifecycleState === "DRAFT"
              ? `Draft saved to LinkedIn! You can find it in your LinkedIn drafts to review and publish.\n\nPost ID: ${postId}`
              : `Post published to LinkedIn! (Note: LinkedIn's API doesn't support drafts for personal posts, so it was published directly.)\n\nPost ID: ${postId}`;
          return { content: [{ type: "text" as const, text: message }] };
        }

        const errorBody = await response.text();
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create post (HTTP ${response.status}):\n${errorBody}`,
            },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error creating LinkedIn post: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool: Auth Status ---

  server.tool(
    "linkedin-auth-status",
    "Check if LinkedIn OAuth is configured and the access token is valid.",
    {},
    async () => {
      if (!accessToken) {
        const loginUrl = `${BASE_URL}/auth/login`;
        return {
          content: [
            {
              type: "text" as const,
              text: `Not authenticated. Visit this URL to connect your LinkedIn account:\n\n${loginUrl}`,
            },
          ],
        };
      }

      // Verify the token is still valid
      try {
        const res = await fetch("https://api.linkedin.com/v2/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (res.ok) {
          const info = (await res.json()) as { localizedFirstName?: string; localizedLastName?: string };
          const name = [info.localizedFirstName, info.localizedLastName].filter(Boolean).join(" ") || "Unknown";
          return {
            content: [
              {
                type: "text" as const,
                text: `Authenticated as: ${name || "Unknown"}\nPerson URN: ${personUrn}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Token is expired or invalid (HTTP ${res.status}). Please re-authenticate:\n\n${BASE_URL}/auth/login`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking auth: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// --- LinkedIn API helper ---

async function createPost(commentary: string, lifecycleState: string) {
  return fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "LinkedIn-Version": "202604",
    },
    body: JSON.stringify({
      author: personUrn,
      commentary,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState,
      isReshareDisabledByAuthor: false,
    }),
  });
}

// --- HTTP Server ---

const app = express();
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

// --- OAuth2 Endpoints ---

app.get("/auth/login", (_req, res) => {
  if (!LINKEDIN_CLIENT_ID) {
    res.status(500).send("LINKEDIN_CLIENT_ID not configured");
    return;
  }

  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: LINKEDIN_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state,
    scope: "openid profile w_member_social",
  });

  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
});

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  try {
    // Exchange code for token
    const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: LINKEDIN_CLIENT_ID,
        client_secret: LINKEDIN_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      res.status(400).send(`Token exchange failed: ${err}`);
      return;
    }

    const tokenData = (await tokenRes.json()) as { access_token: string; expires_in: number };
    accessToken = tokenData.access_token;

    // Try multiple endpoints to get person URN
    let userName = "Unknown";

    // Try /v2/me first
    const meRes = await fetch("https://api.linkedin.com/v2/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (meRes.ok) {
      const meData = (await meRes.json()) as { id: string; localizedFirstName?: string; localizedLastName?: string };
      personUrn = `urn:li:person:${meData.id}`;
      userName = [meData.localizedFirstName, meData.localizedLastName].filter(Boolean).join(" ") || "Unknown";
    } else {
      // Try /v2/userinfo
      const uiRes = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (uiRes.ok) {
        const uiData = (await uiRes.json()) as { sub: string; name?: string };
        personUrn = `urn:li:person:${uiData.sub}`;
        userName = uiData.name || "Unknown";
      } else {
        // Last resort: use the REST API /me endpoint with versioned header
        const restMeRes = await fetch("https://api.linkedin.com/rest/me", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "LinkedIn-Version": "202604",
            "X-Restli-Protocol-Version": "2.0.0",
          },
        });
        if (restMeRes.ok) {
          const restData = (await restMeRes.json()) as { id?: string; sub?: string };
          const id = restData.sub || restData.id || "";
          personUrn = `urn:li:person:${id}`;
        } else {
          // Store token anyway — user can set LINKEDIN_PERSON_URN manually
          console.log("Could not auto-detect person URN. User must set LINKEDIN_PERSON_URN env var.");
        }
      }
    }

    const expiresInDays = Math.round(tokenData.expires_in / 86400);

    res.send(`
      <html>
        <body style="font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 20px;">
          <h1>LinkedIn Connected!</h1>
          <p>Authenticated as: <strong>${userName}</strong></p>
          ${personUrn ? `<p>Person URN: <code>${personUrn}</code></p>` : `<p style="color:orange;">Could not auto-detect Person URN. Set LINKEDIN_PERSON_URN env var manually.</p>`}
          <p>Token expires in: ${expiresInDays} days</p>
          <hr>
          <h2>Save these as Railway environment variables for persistence:</h2>
          <pre style="background: #f5f5f5; padding: 16px; border-radius: 8px; overflow-x: auto;">LINKEDIN_ACCESS_TOKEN=${accessToken}
LINKEDIN_PERSON_URN=${personUrn}</pre>
          <p>You can now close this tab. The MCP server is ready to create LinkedIn drafts.</p>
        </body>
      </html>
    `);
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error("OAuth callback error:", msg);
    res.status(500).send(`OAuth error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.get("/auth/status", (_req, res) => {
  if (!accessToken) {
    res.json({ authenticated: false, loginUrl: `${BASE_URL}/auth/login` });
  } else {
    res.json({ authenticated: true, personUrn });
  }
});

// --- MCP Endpoints ---

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId) {
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
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
    res.status(404).json({ error: "No active session" });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(404).json({ error: "No active session" });
    return;
  }
  await transport.handleRequest(req, res);
  if (transport.sessionId) transports.delete(transport.sessionId);
});

const PORT = parseInt(process.env.PORT || "3847", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`LinkedIn MCP server running on http://0.0.0.0:${PORT}/mcp`);
  console.log(`OAuth login: http://0.0.0.0:${PORT}/auth/login`);
  console.log(`Auth status: http://0.0.0.0:${PORT}/auth/status`);
});
