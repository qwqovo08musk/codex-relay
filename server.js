const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Admin-Secret"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

const PORT = process.env.PORT || 3000;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const INPUT_PRICE_PER_1K = 0.02;
const OUTPUT_PRICE_PER_1K = 0.15;

const MAX_OUTPUT_TOKENS = 8192;
const MAX_INPUT_CHARS = 500000;

function calculateCost(inputTokens, outputTokens) {
  const inputCost =
    (Number(inputTokens || 0) / 1000) * INPUT_PRICE_PER_1K;

  const outputCost =
    (Number(outputTokens || 0) / 1000) * OUTPUT_PRICE_PER_1K;

  return Number((inputCost + outputCost).toFixed(6));
}

function estimateInputTokens(messages) {
  let characters = 0;

  for (const message of messages || []) {
    if (!message) continue;

    if (typeof message.content === "string") {
      characters += message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (typeof item === "string") {
          characters += item.length;
        } else if (item && typeof item.text === "string") {
          characters += item.text.length;
        }
      }
    }
  }

  return Math.max(Math.ceil(characters / 2), 1);
}

function getApiKey(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  return auth.slice(7).trim();
}

function checkAdmin(req) {
  const secret = req.headers["x-admin-secret"];

  return Boolean(
    ADMIN_SECRET &&
    secret === ADMIN_SECRET
  );
}

function generateCustomerKey() {
  return "cr_" + crypto.randomBytes(24).toString("hex");
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Codex Relay API is running"
  });
});

/* =========================
   Create customer key
========================= */

app.post("/admin/create-key", async (req, res) => {
  try {
    if (!checkAdmin(req)) {
      return res.status(401).json({
        error: { message: "Unauthorized" }
      });
    }

    const apiKey = generateCustomerKey();

    const result = await pool.query(
      `INSERT INTO api_keys
       ("key", balance, total_tokens, active)
       VALUES ($1, 0, 0, true)
       RETURNING "key", balance, total_tokens, active, created_at`,
      [apiKey]
    );

    res.json({
      success: true,
      key: result.rows[0]
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: {
        message: "Failed to create API key",
        details: error.message
      }
    });
  }
});

/* =========================
   Add balance
========================= */

app.post("/admin/add-balance", async (req, res) => {
  try {
    if (!checkAdmin(req)) {
      return res.status(401).json({
        error: { message: "Unauthorized" }
      });
    }

    const apiKey = String(req.body.api_key || "").trim();
    const amount = Number(req.body.amount);
    const note = req.body.note
      ? String(req.body.note)
      : "Admin top-up";

    if (!apiKey || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: {
          message: "Invalid API key or amount"
        }
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `UPDATE api_keys
         SET balance = balance + $1,
             updated_at = now()
         WHERE "key" = $2
         AND active = true
         RETURNING balance`,
        [amount, apiKey]
      );

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: {
            message: "API key not found or disabled"
          }
        });
      }

      await client.query(
        `INSERT INTO balance_transactions
         (api_key, amount, type, note)
         VALUES ($1, $2, 'topup', $3)`,
        [apiKey, amount, note]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        balance: Number(result.rows[0].balance)
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: {
        message: "Failed to add balance",
        details: error.message
      }
    });
  }
});

/* =========================
   Check balance
========================= */

app.get("/v1/balance", async (req, res) => {
  try {
    const apiKey = getApiKey(req);

    if (!apiKey) {
      return res.status(401).json({
        error: {
          message: "Missing API key"
        }
      });
    }

    const result = await pool.query(
      `SELECT balance, active, total_tokens
       FROM api_keys
       WHERE "key" = $1`,
      [apiKey]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: {
          message: "Invalid API key"
        }
      });
    }

    if (!result.rows[0].active) {
      return res.status(403).json({
        error: {
          message: "API key is disabled"
        }
      });
    }

    res.json({
      balance: Number(result.rows[0].balance),
      total_tokens: Number(result.rows[0].total_tokens || 0),
      active: true
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: {
        message: "Failed to get balance",
        details: error.message
      }
    });
  }
});

/* =========================
   Disable key
========================= */

app.post("/admin/disable-key", async (req, res) => {
  try {
    if (!checkAdmin(req)) {
      return res.status(401).json({
        error: { message: "Unauthorized" }
      });
    }

    const apiKey = String(req.body.api_key || "").trim();

    if (!apiKey) {
      return res.status(400).json({
        error: {
          message: "API key is required"
        }
      });
    }

    const result = await pool.query(
      `UPDATE api_keys
       SET active = false,
           updated_at = now()
       WHERE "key" = $1
       RETURNING "key", active`,
      [apiKey]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          message: "API key not found"
        }
      });
    }

    res.json({
      success: true,
      key: result.rows[0]
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: {
        message: "Failed to disable key",
        details: error.message
      }
    });
  }
});

/* =========================
   Chat
========================= */

app.post("/v1/chat/completions", async (req, res) => {
  let reservedAmount = 0;
  let reservationKey = null;

  try {
    if (!DASHSCOPE_API_KEY) {
      return res.status(500).json({
        error: {
          message: "DASHSCOPE_API_KEY is not configured"
        }
      });
    }

    if (!DATABASE_URL) {
      return res.status(500).json({
        error: {
          message: "DATABASE_URL is not configured"
        }
      });
    }

    const apiKey = getApiKey(req);

    if (!apiKey) {
      return res.status(401).json({
        error: {
          message: "Missing API key"
        }
      });
    }

    const {
      messages,
      model = "qwen3.5-27b",
      temperature,
      max_tokens
    } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "messages must be a non-empty array"
        }
      });
    }

    const inputCharacters = JSON.stringify(messages).length;

    if (inputCharacters > MAX_INPUT_CHARS) {
      return res.status(413).json({
        error: {
          message: "Request is too large"
        }
      });
    }

    const safeMaxTokens = Math.min(
      Math.max(Number(max_tokens) || 4096, 1),
      MAX_OUTPUT_TOKENS
    );

    const estimatedInputTokens =
      estimateInputTokens(messages);

    /*
      Reserve ONLY the maximum possible cost.
      NEVER set the customer's whole balance to zero.
    */

    const estimatedMaximumCost = calculateCost(
      Math.ceil(estimatedInputTokens * 1.25),
      safeMaxTokens
    );

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const reserveResult = await client.query(
        `UPDATE api_keys
         SET balance = balance - $1,
             updated_at = now()
         WHERE "key" = $2
           AND active = true
           AND balance >= $1
         RETURNING balance`,
        [
          estimatedMaximumCost,
          apiKey
        ]
      );

      if (reserveResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(402).json({
          error: {
            message: "Insufficient balance for this request"
          }
        });
      }

      reservedAmount = estimatedMaximumCost;
      reservationKey = apiKey;

      await client.query(
        `INSERT INTO balance_transactions
         (api_key, amount, type, note)
         VALUES ($1, $2, 'reservation', $3)`,
        [
          apiKey,
          -reservedAmount,
          "Temporary API request reservation"
        ]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    /* =========================
       Call Alibaba Cloud
    ========================= */

    const upstreamBody = {
      model,
      messages,
      max_tokens: safeMaxTokens
    };

    if (typeof temperature === "number") {
      upstreamBody.temperature = temperature;
    }

    let response;

    try {
      response = await fetch(
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${DASHSCOPE_API_KEY}`
          },
          body: JSON.stringify(upstreamBody)
        }
      );
    } catch (error) {
      await refundReservation(
        reservationKey,
        reservedAmount,
        "Upstream request failed"
      );

      reservedAmount = 0;

      return res.status(502).json({
        error: {
          message: "Upstream API request failed"
        }
      });
    }

    let data;

    try {
      data = await response.json();
    } catch (error) {
      await refundReservation(
        reservationKey,
        reservedAmount,
        "Invalid upstream response"
      );

      reservedAmount = 0;

      return res.status(502).json({
        error: {
          message: "Invalid upstream response"
        }
      });
    }

    if (!response.ok) {
      await refundReservation(
        reservationKey,
        reservedAmount,
        "Upstream API returned an error"
      );

      reservedAmount = 0;

      return res.status(response.status).json(data);
    }

    /* =========================
       Calculate actual cost
    ========================= */

    const inputTokens = Number(
      data?.usage?.prompt_tokens ||
      data?.usage?.input_tokens ||
      0
    );

    const outputTokens = Number(
      data?.usage?.completion_tokens ||
      data?.usage?.output_tokens ||
      0
    );

    const totalTokens = Number(
      data?.usage?.total_tokens ||
      inputTokens + outputTokens
    );

    const actualCost = calculateCost(
      inputTokens,
      outputTokens
    );

    /*
      Safety rule:
      actual cost must never exceed reservation.
    */

    if (actualCost > reservedAmount) {
      await refundReservation(
        reservationKey,
        reservedAmount,
        "Billing safety refund"
      );

      reservedAmount = 0;

      return res.status(500).json({
        error: {
          message:
            "Billing safety check failed. Reservation refunded."
        }
      });
    }

    /*
      Refund unused reservation.

      Example:
      Reserved RM0.60
      Actual RM0.06
      Refund RM0.54
    */

    const refundAmount = Number(
      (reservedAmount - actualCost).toFixed(6)
    );

    const finalClient = await pool.connect();

    try {
      await finalClient.query("BEGIN");

      if (refundAmount > 0) {
        await finalClient.query(
          `UPDATE api_keys
           SET balance = balance + $1,
               total_tokens = total_tokens + $2,
               updated_at = now()
           WHERE "key" = $3`,
          [
            refundAmount,
            totalTokens,
            apiKey
          ]
        );

        await finalClient.query(
          `INSERT INTO balance_transactions
           (api_key, amount, type, note)
           VALUES ($1, $2, 'refund', $3)`,
          [
            apiKey,
            refundAmount,
            "Unused request reservation"
          ]
        );
      } else {
        await finalClient.query(
          `UPDATE api_keys
           SET total_tokens = total_tokens + $1,
               updated_at = now()
           WHERE "key" = $2`,
          [
            totalTokens,
            apiKey
          ]
        );
      }

      await finalClient.query(
        `INSERT INTO usage_logs
         (api_key, model, input_tokens, output_tokens, cost)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          apiKey,
          model,
          inputTokens,
          outputTokens,
          actualCost
        ]
      );

      await finalClient.query(
        `INSERT INTO balance_transactions
         (api_key, amount, type, note)
         VALUES ($1, $2, 'usage', $3)`,
        [
          apiKey,
          -actualCost,
          `${model} API usage`
        ]
      );

      const balanceResult = await finalClient.query(
        `SELECT balance
         FROM api_keys
         WHERE "key" = $1`,
        [apiKey]
      );

      await finalClient.query("COMMIT");

      const remainingBalance = Number(
        balanceResult.rows[0].balance
      );

      data.billing = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost_rm: actualCost,
        remaining_balance_rm: remainingBalance
      };

      reservedAmount = 0;
      reservationKey = null;

      return res.json(data);
    } catch (error) {
      await finalClient.query("ROLLBACK");
      throw error;
    } finally {
      finalClient.release();
    }
  } catch (error) {
    console.error(error);

    if (
      reservedAmount > 0 &&
      reservationKey
    ) {
      await refundReservation(
        reservationKey,
        reservedAmount,
        "Server error refund"
      );
    }

    if (!res.headersSent) {
      return res.status(500).json({
        error: {
          message: "Relay server error",
          details: error.message
        }
      });
    }
  }
});

/* =========================
   Refund helper
========================= */

async function refundReservation(
  apiKey,
  amount,
  note
) {
  if (!apiKey || !amount || amount <= 0) {
    return;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE api_keys
       SET balance = balance + $1,
           updated_at = now()
       WHERE "key" = $2`,
      [
        amount,
        apiKey
      ]
    );

    await client.query(
      `INSERT INTO balance_transactions
       (api_key, amount, type, note)
       VALUES ($1, $2, 'refund', $3)`,
      [
        apiKey,
        amount,
        note
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Refund failed:", error);
  } finally {
    client.release();
  }
}

/* =========================
   Start
========================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Codex Relay running on port ${PORT}`
    );
  }
);
