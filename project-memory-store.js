const axios = require("axios");

const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || "main";
const TOKEN = process.env.GITHUB_TOKEN;
const FILE_PATH = process.env.GITHUB_MEMORY_PATH;

const headers = {
  Authorization: `token ${TOKEN}`,
  Accept: "application/vnd.github+json"
};

async function readMemory() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;

  const response = await axios.get(url, { headers });

  const json = Buffer.from(response.data.content, "base64").toString("utf8");

  return {
    sha: response.data.sha,
    memory: JSON.parse(json)
  };
}

async function writeMemory(memory, sha) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;

  const content = Buffer.from(
    JSON.stringify(memory, null, 2),
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
}

async function addMemoryEntry(entry) {
  const { sha, memory } = await readMemory();

  const item = {
    id: Date.now().toString(),
    createdAt: new Date().toISOString(),
    ...entry
  };

  switch (entry.type) {
    case "rule":
      memory.activeRules.push(item);
      break;

    case "article":
      memory.articleHistory.push(item);
      break;

    case "decision":
      memory.importantDecisions.push(item);
      break;

    case "todo":
      memory.todos.push(item);
      break;

    default:
      memory.recentChanges.push(item);
  }

  memory.updatedAt = new Date().toISOString();

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
