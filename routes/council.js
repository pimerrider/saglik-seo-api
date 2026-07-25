const express = require("express");
const router = express.Router();
const { research } = require("../agents/research/gemini");
const { judge } = require("../agents/judge/gpt");

const MAX_ROUNDS = parseInt(process.env.COUNCIL_MAX_ROUNDS, 10) || 4;

// Bellek içi oturum takibi (basit; kalıcı olması gerekirse DB/Redis'e taşınır)
const sessions = {};

/**
 * POST /council/start
 * body: { mode, topic, providedData }
 * Yeni bir görev başlatır, ilk tur(lar)ı çalıştırır.
 */
router.post("/start", async (req, res) => {
  const { mode, topic, providedData = {} } = req.body;

  if (!mode || !topic) {
    return res.status(400).json({ error: "mode ve topic zorunlu" });
  }

  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  sessions[sessionId] = { mode, topic, providedData, round: 0 };

  const result = await runLoop(sessionId);
  return res.json({ sessionId, ...result });
});

/**
 * POST /council/continue
 * body: { sessionId, additionalData }
 * Eksik veri kullanıcıdan geldiğinde çağrılır, döngüye kaldığı yerden devam eder.
 */
router.post("/continue", async (req, res) => {
  const { sessionId, additionalData = {} } = req.body;

  const session = sessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: "Oturum bulunamadı veya süresi doldu" });
  }

  session.providedData = { ...session.providedData, ...additionalData };
  const result = await runLoop(sessionId);
  return res.json({ sessionId, ...result });
});

async function runLoop(sessionId) {
  const session = sessions[sessionId];
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

    const verdict = await judge(
      session.mode,
      session.topic,
      draft,
      session.round,
      forceFinal
    );

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
      delete sessions[sessionId]; // tamamlandı, oturumu temizle
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

