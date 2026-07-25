const express = require("express");
const { createHash, randomUUID, timingSafeEqual } = require("crypto");
const router = express.Router();
const { research } = require("../agents/research/gemini");
const { judge, INVALID_VERDICT_CODE } = require("../agents/judge/gpt");

const MAX_ROUNDS = parseInt(process.env.COUNCIL_MAX_ROUNDS, 10) || 4;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_DATA_BYTES = 200 * 1024;
const ALLOWED_MODES = new Set(["article", "story", "cover-image", "seo"]);

// Bellek içi oturum takibi (basit; kalıcı olması gerekirse DB/Redis'e taşınır)
const sessions = new Map();

function cleanupExpiredSessions(now = Date.now()) {
  for (const [sessionId, session] of sessions) {
    if (now - session.createdAt >= SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getJsonByteLength(value) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      return null;
    }
    return Buffer.byteLength(serialized, "utf8");
  } catch (error) {
    return null;
  }
}

function secretsMatch(provided, expected) {
  if (typeof provided !== "string") {
    return false;
  }

  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function requireCouncilApiKey(req, res, next) {
  const expectedKey = process.env.COUNCIL_API_KEY;
  if (typeof expectedKey !== "string" || expectedKey.length === 0) {
    return res.status(503).json({ error: "Council API kullanıma hazır değil" });
  }

  const providedKey = req.get("x-council-key");
  if (!secretsMatch(providedKey, expectedKey)) {
    return res.status(401).json({ error: "Yetkisiz Council isteği" });
  }

  return next();
}

function handleCouncilError(res, error) {
  if (error && error.code === INVALID_VERDICT_CODE) {
    return res.status(502).json({
      status: "error",
      message: "GPT verdict could not be validated",
    });
  }

  throw error;
}

/**
 * POST /council/start
 * body: { mode, topic, providedData }
 * Yeni bir görev başlatır, ilk tur(lar)ı çalıştırır.
 */
router.post("/start", requireCouncilApiKey, async (req, res) => {
  cleanupExpiredSessions();
  const body = isPlainObject(req.body) ? req.body : {};
  const { mode, topic } = body;
  const providedData = body.providedData === undefined ? {} : body.providedData;

  if (!ALLOWED_MODES.has(mode)) {
    return res.status(400).json({ error: "mode geçersiz" });
  }

  if (
    typeof topic !== "string" ||
    topic.trim().length === 0 ||
    topic.length > 500
  ) {
    return res.status(400).json({ error: "topic geçersiz" });
  }

  if (!isPlainObject(providedData)) {
    return res.status(400).json({ error: "providedData plain object olmalı" });
  }

  const providedDataBytes = getJsonByteLength(providedData);
  if (providedDataBytes === null) {
    return res.status(400).json({ error: "providedData JSON olarak işlenemedi" });
  }
  if (providedDataBytes > MAX_DATA_BYTES) {
    return res.status(400).json({ error: "providedData 200 KB sınırını aşıyor" });
  }

  const sessionId = randomUUID();
  sessions.set(sessionId, {
    mode,
    topic: topic.trim(),
    providedData,
    round: 0,
    createdAt: Date.now(),
  });

  try {
    const result = await runLoop(sessionId);
    return res.json({ sessionId, ...result });
  } catch (error) {
    return handleCouncilError(res, error);
  }
});

/**
 * POST /council/continue
 * body: { sessionId, additionalData }
 * Eksik veri kullanıcıdan geldiğinde çağrılır, döngüye kaldığı yerden devam eder.
 */
router.post("/continue", requireCouncilApiKey, async (req, res) => {
  const body = isPlainObject(req.body) ? req.body : {};
  const { sessionId } = body;
  const additionalData =
    body.additionalData === undefined ? {} : body.additionalData;

  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return res.status(400).json({ error: "sessionId geçersiz" });
  }

  if (!isPlainObject(additionalData)) {
    return res.status(400).json({ error: "additionalData plain object olmalı" });
  }

  cleanupExpiredSessions();
  const normalizedSessionId = sessionId.trim();
  if (!sessions.has(normalizedSessionId)) {
    return res.status(404).json({ error: "Oturum bulunamadı veya süresi doldu" });
  }

  const session = sessions.get(normalizedSessionId);
  const mergedData = { ...session.providedData, ...additionalData };
  const mergedDataBytes = getJsonByteLength(mergedData);
  if (mergedDataBytes === null) {
    return res.status(400).json({ error: "additionalData JSON olarak işlenemedi" });
  }
  if (mergedDataBytes > MAX_DATA_BYTES) {
    return res.status(400).json({
      error: "Birleştirilmiş providedData 200 KB sınırını aşıyor",
    });
  }

  session.providedData = mergedData;
  try {
    const result = await runLoop(normalizedSessionId);
    return res.json({ sessionId: normalizedSessionId, ...result });
  } catch (error) {
    return handleCouncilError(res, error);
  }
});

async function runLoop(sessionId) {
  const session = sessions.get(sessionId);
  let judgeFeedback = null;

  while (session.round < MAX_ROUNDS) {
    session.round += 1;
    const forceFinal = session.round === MAX_ROUNDS;

    const { draft } = await research(
      session.mode,
      session.topic,
      session.providedData,
      judgeFeedback
    );

    let verdict;
    try {
      verdict = await judge(
        session.mode,
        session.topic,
        draft,
        session.round,
        forceFinal
      );
    } catch (error) {
      if (error && error.code === INVALID_VERDICT_CODE) {
        session.round -= 1;
      }
      throw error;
    }

    if (forceFinal) {
      const verdictOutput =
        typeof verdict.finalOutput === "string" ? verdict.finalOutput.trim() : "";
      const draftOutput = typeof draft === "string" ? draft.trim() : "";
      const finalOutput = verdictOutput
        ? verdict.finalOutput
        : draftOutput
          ? draft
          : "Final output could not be generated.";

      sessions.delete(sessionId);
      return {
        status: "complete",
        roundsUsed: session.round,
        finalOutput,
      };
    }

    if (verdict.missingFields && verdict.missingFields.length > 0 && !forceFinal) {
      // Eksik veri var - kullanıcıdan iste, oturumu bekletme durumunda bırak
      return {
        status: "needs_input",
        round: session.round,
        missingFields: verdict.missingFields,
        note: "Bu alanları /continue ile gönder",
      };
    }

    if (verdict.satisfied) {
      sessions.delete(sessionId); // tamamlandı, oturumu temizle
      return {
        status: "complete",
        roundsUsed: session.round,
        finalOutput: verdict.finalOutput,
      };
    }

    judgeFeedback = verdict.feedback;
  }

  // Buraya normalde düşmemeli (forceFinal 4. turda satisfied=true zorunlu)
  return { status: "error", note: "Maksimum tur sayısına ulaşıldı ama final üretilemedi" };
}

module.exports = router;

