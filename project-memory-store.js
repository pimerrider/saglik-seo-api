const fs = require("fs");
const path = require("path");

const MEMORY_FILE = path.join(__dirname, "turkishdishes-project-memory.json");

function readMemory() {
  if (!fs.existsSync(MEMORY_FILE)) {
    return {
      activeRules: [],
      recentChanges: [],
      articleHistory: [],
      importantDecisions: [],
      todos: [],
      updatedAt: new Date().toISOString()
    };
  }

  return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
}

function writeMemory(memory) {
  memory.updatedAt = new Date().toISOString();
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), "utf8");
}

function addMemoryEntry(entry) {
  const memory = readMemory();

  const item = {
    id: Date.now().toString(),
    date: new Date().toISOString(),
    ...entry
  };

  if (entry.type === "rule") memory.activeRules.push(item);
  else if (entry.type === "article") memory.articleHistory.push(item);
  else if (entry.type === "decision") memory.importantDecisions.push(item);
  else if (entry.type === "todo") memory.todos.push(item);
  else memory.recentChanges.push(item);

  writeMemory(memory);
  return item;
}

module.exports = {
  readMemory,
  addMemoryEntry
};
