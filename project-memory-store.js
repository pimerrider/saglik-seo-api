const axios = require("axios");

const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || "main";
const TOKEN = process.env.GITHUB_TOKEN;
const FILE_PATH = process.env.GITHUB_MEMORY_PATH;

if (!OWNER || !REPO || !TOKEN || !FILE_PATH) {
  console.warn("GitHub memory ENV eksik: GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, GITHUB_MEMORY_PATH kontrol et.");
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Cache-Control": "no-cache"
};

function normalizeMemory(memory = {}) {
  return {
    activeRules: Array.isArray(memory.activeRules) ? memory.activeRules : [],
    recentChanges: Array.isArray(memory.recentChanges) ? memory.recentChanges : [],
    articleHistory: Array.isArray(memory.articleHistory) ? memory.articleHistory : [],
    importantDecisions: Array.isArray(memory.importantDecisions) ? memory.importantDecisions : [],
    todos: Array.isArray(memory.todos) ? memory.todos : [],
    updatedAt: memory.updatedAt || null
  };
}

async function readMemory() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}&t=${Date.now()}`;
  const response = await axios.get(url, { headers });

  const json = Buffer.from(response.data.content, "base64").toString("utf8");
  const memory = normalizeMemory(JSON.parse(json));

  return {
    sha: response.data.sha,
    memory
  };
}

async function writeMemory(memory, sha) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;

  const normalized = normalizeMemory(memory);
  normalized.updatedAt = new Date().toISOString();

  const content = Buffer.from(
    JSON.stringify(normalized, null, 2),
    "utf8"
  ).toString("base64");

  await axios.put(
    url,
    {
      message: `Update project memory ${new Date().toISOString()}`,
      content,
      sha,
      branch: BRANCH
    },
    { headers }
  );

  return normalized;
}

async function addMemoryEntry(entry = {}) {
  const { sha, memory } = await readMemory();

  const item = {
    id: Date.now().toString(),
    createdAt: new Date().toISOString(),
    type: entry.type || "change",
    title: entry.title || "Untitled memory entry",
    summary: entry.summary || "",
    category: entry.category || "",
    status: entry.status || "",
    url: entry.url || "",
    decision: entry.decision || "",
    reason: entry.reason || "",
    actions: Array.isArray(entry.actions) ? entry.actions : []
  };

  if (item.type === "rule") {
    memory.activeRules.push(item);
  } else if (item.type === "article") {
    memory.articleHistory.push(item);
  } else if (item.type === "decision") {
    memory.importantDecisions.push(item);
  } else if (item.type === "todo") {
    memory.todos.push(item);
  } else {
    memory.recentChanges.push(item);
  }

  await writeMemory(memory, sha);

  return item;
}

async function getMemory() {
  const { memory } = await readMemory();
  return memory;
}

async function getSummary() {
  const { memory } = await readMemory();

  return {
    activeRules: memory.activeRules.slice(-20),
    recentChanges: memory.recentChanges.slice(-20),
    articleHistory: memory.articleHistory.slice(-20),
    importantDecisions: memory.importantDecisions.slice(-20),
    todos: memory.todos.slice(-20),
    updatedAt: memory.updatedAt
  };
}

module.exports = {
  getMemory,
  addMemoryEntry,
  getSummary
};
