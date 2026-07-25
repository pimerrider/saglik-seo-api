const express = require("express");
const { createHash, randomUUID, timingSafeEqual } = require("crypto");
const router = express.Router();
const { research } = require("../agents/research/gemini");
const { judge, INVALID_VERDICT_CODE } = require("../agents/judge/gpt");

const PROVIDER_TIMEOUT_MS = 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_DATA_BYTES = 200 * 1024;
const ALLOWED_MODES = new Set(["article", "story", "cover-image", "seo"]);
const PROVIDER_TIMEOUT_CODE = "COUNCIL_PROVIDER_TIMEOUT";
const CLIENT_ABORT_CODE = "COUNCIL_CLIENT_ABORT";
const PROVIDER_ERROR_CODE = "COUNCIL_PROVIDER_ERROR";

function getMaxRounds(value) {
  return typeof value === "string" && /^[1-4]$/.test(value)
    ? Number(value)
    : 4;
}

const MAX_ROUNDS = getMaxRounds(process.env.COUNCIL_MAX_ROUNDS);

// Bellek içi oturum takibi (basit; kalıcı olması gerekirse DB/Redis'e taşınır)
const sessions = new Map();

function cleanupExpiredSessions(now = Date.now()) {
  for (const [sessionId, session] of sessions) {
    if (!session.processing && now - session.createdAt >= SESSION_TTL_MS) {
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

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({ status: "error", message });
}

function createCouncilError(code, statusCode, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.cause = cause;
  return error;
}

function handleCouncilError(res, error) {
  if (error?.code === CLIENT_ABORT_CODE && res.destroyed) {
    return;
  }

  if (error?.code === INVALID_VERDICT_CODE) {
    return sendError(res, 502, "GPT verdict could not be validated");
  }

  if (Number.isInteger(error?.statusCode)) {
    if (error.code === PROVIDER_ERROR_CODE) {
      console.error("[COUNCIL PROVIDER]", error.cause || error);
    }
    return sendError(res, error.statusCode, error.message);
  }

  console.error("[COUNCIL]", error);
  return sendError(res, 500, "Unexpected Council error");
}

function councilRoute(handler) {
  return async (req, res) => {
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded && !controller.signal.aborted) {
        controller.abort();
      }
    };

    req.once("aborted", abort);
    res.once("close", abort);

    try {
      return await handler(req, res, controller.signal);
    } catch (error) {
      return handleCouncilError(res, error);
    } finally {
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    }
  };
}

async function callProvider(providerName, requestSignal, operation) {
  if (requestSignal.aborted) {
    throw createCouncilError(CLIENT_ABORT_CODE, 499, "Client disconnected");
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromRequest = () => controller.abort();
  requestSignal.addEventListener("abort", abortFromRequest, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROVIDER_TIMEOUT_MS);
  timeout.unref?.();

  let rejectCancellation;
  const cancelled = new Promise((_resolve, reject) => {
    rejectCancellation = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectCancellation, {
      once: true,
    });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      cancelled,
    ]);
  } catch (error) {
    if (timedOut) {
      throw createCouncilError(
        PROVIDER_TIMEOUT_CODE,
        504,
        `${providerName} request timed out`,
        error
      );
    }
    if (requestSignal.aborted) {
      throw createCouncilError(
        CLIENT_ABORT_CODE,
        499,
        "Client disconnected",
        error
      );
    }
    if (error?.code === INVALID_VERDICT_CODE) {
      throw error;
    }

    throw createCouncilError(
      PROVIDER_ERROR_CODE,
      502,
      `${providerName} request failed`,
      error
    );
  } finally {
    clearTimeout(timeout);
    requestSignal.removeEventListener("abort", abortFromRequest);
    controller.signal.removeEventListener("abort", rejectCancellation);
  }
}

function requireCouncilApiKey(req, res, next) {
  const expectedKey = process.env.COUNCIL_API_KEY;
  if (typeof expectedKey !== "string" || expectedKey.length === 0) {
    return sendError(res, 503, "Council API kullanıma hazır değil");
  }

  const providedKey = req.get("x-council-key");
  if (!secretsMatch(providedKey, expectedKey)) {
    return sendError(res, 401, "Yetkisiz Council isteği");
  }

  return next();
}

/**
 * POST /council/start
 * body: { mode, topic, providedData }
 * Yeni bir görev başlatır, ilk tur(lar)ı çalıştırır.
 */
router.post("/start", requireCouncilApiKey, councilRoute(async (req, res, signal) => {
  cleanupExpiredSessions();
  const body = isPlainObject(req.body) ? req.body : {};
  const { mode, topic } = body;
  const providedData = body.providedData === undefined ? {} : body.providedData;

  if (!ALLOWED_MODES.has(mode)) {
    return sendError(res, 400, "mode geçersiz");
  }

  if (
    typeof topic !== "string" ||
    topic.trim().length === 0 ||
    topic.length > 500
  ) {
    return sendError(res, 400, "topic geçersiz");
  }

  if (!isPlainObject(providedData)) {
    return sendError(res, 400, "providedData plain object olmalı");
  }

  const providedDataBytes = getJsonByteLength(providedData);
  if (providedDataBytes === null) {
    return sendError(res, 400, "providedData JSON olarak işlenemedi");
  }
  if (providedDataBytes > MAX_DATA_BYTES) {
    return sendError(res, 400, "providedData 200 KB sınırını aşıyor");
  }

  const sessionId = randomUUID();
  const session = {
    mode,
    topic: topic.trim(),
    providedData,
    round: 0,
    createdAt: Date.now(),
    processing: true,
  };
  sessions.set(sessionId, session);

  try {
    const result = await runLoop(sessionId, signal);
    return res.json({ sessionId, ...result });
  } catch (error) {
    sessions.delete(sessionId);
    throw error;
  } finally {
    if (sessions.get(sessionId) === session) {
      session.processing = false;
    }
  }
}));

/**
 * POST /council/continue
 * body: { sessionId, additionalData }
 * Eksik veri kullanıcıdan geldiğinde çağrılır, döngüye kaldığı yerden devam eder.
 */
router.post("/continue", requireCouncilApiKey, councilRoute(async (req, res, signal) => {
  const body = isPlainObject(req.body) ? req.body : {};
  const { sessionId } = body;
  const additionalData =
    body.additionalData === undefined ? {} : body.additionalData;

  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return sendError(res, 400, "sessionId geçersiz");
  }

  if (!isPlainObject(additionalData)) {
    return sendError(res, 400, "additionalData plain object olmalı");
  }

  cleanupExpiredSessions();
  const normalizedSessionId = sessionId.trim();
  const session = sessions.get(normalizedSessionId);
  if (!session) {
    return sendError(res, 404, "Oturum bulunamadı veya süresi doldu");
  }

  if (session.processing) {
    return sendError(res, 409, "Session is already processing");
  }
  session.processing = true;

  try {
    const mergedData = { ...session.providedData, ...additionalData };
    const mergedDataBytes = getJsonByteLength(mergedData);
    if (mergedDataBytes === null) {
      return sendError(res, 400, "additionalData JSON olarak işlenemedi");
    }
    if (mergedDataBytes > MAX_DATA_BYTES) {
      return sendError(
        res,
        400,
        "Birleştirilmiş providedData 200 KB sınırını aşıyor"
      );
    }

    session.providedData = mergedData;
    const result = await runLoop(normalizedSessionId, signal);
    return res.json({ sessionId: normalizedSessionId, ...result });
  } finally {
    session.processing = false;
  }
}));

async function runLoop(sessionId, signal) {
  const session = sessions.get(sessionId);
  let judgeFeedback = null;

  while (session.round < MAX_ROUNDS) {
    const previousRound = session.round;
    session.round += 1;
    const forceFinal = session.round === MAX_ROUNDS;

    try {
      const { draft } = await callProvider(
        "Gemini",
        signal,
        (providerSignal) =>
          research(
            session.mode,
            session.topic,
            session.providedData,
            judgeFeedback,
            providerSignal
          )
      );

      let verdict;
      try {
        verdict = await callProvider(
          "GPT",
          signal,
          (providerSignal) =>
            judge(
              session.mode,
              session.topic,
              draft,
              session.round,
              forceFinal,
              providerSignal
            )
        );
      } catch (error) {
        if (forceFinal && error?.code === INVALID_VERDICT_CODE) {
          verdict = { satisfied: true, feedback: null, missingFields: [], finalOutput: null };
        } else {
          throw error;
        }
      }

      if (forceFinal) {
        const verdictOutput =
          typeof verdict.finalOutput === "string"
            ? verdict.finalOutput.trim()
            : "";
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

      const hasFinalOutput =
        typeof verdict.finalOutput === "string" &&
        verdict.finalOutput.trim().length > 0;

      if (verdict.satisfied && hasFinalOutput) {
        sessions.delete(sessionId);
        return {
          status: "complete",
          roundsUsed: session.round,
          finalOutput: verdict.finalOutput,
        };
      }

      if (verdict.satisfied && !hasFinalOutput && !forceFinal) {
        judgeFeedback = "satisfied=true dendi ama finalOutput boştu, tekrar üret ve finalOutput'u doldur.";
        continue;
      }

      judgeFeedback = verdict.feedback;
    } catch (error) {
      session.round = previousRound;
      throw error;
    }
  }

  throw createCouncilError(
    "COUNCIL_MAX_ROUNDS_REACHED",
    500,
    "Maximum rounds reached without final output"
  );
}

module.exports = router;
