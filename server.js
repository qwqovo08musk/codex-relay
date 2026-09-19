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
    (inputTokens / 1000) * INPUT_PRICE_PER_1K;

  const outputCost =
    (outputTokens / 1000) * OUTPUT_PRICE_PER_1K;

  return Number(
    (inputCost + outputCost).toFixed(6)
  );
}

function estimateInputTokens(messages) {
  let characters = 0;

  for (const message of messages) {
    if (!message) continue;

    if (typeof message.content === "string") {
      characters += message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (typeof item === "string") {
          characters += item.length;
        } else if (
          item &&
          typeof item.text === "string"
        ) {
          characters += item.text.length;
        }
      }
    }
  }

  return Math.ceil(characters / 2);
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

  return (
    ADMIN_SECRET &&
    secret === ADMIN_SECRET
  );
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Codex Relay API is running"
  });
});

app.post("/admin/create-key", async (req, res) => {
  try {
    if (!checkAdmin(req)) {
      return res.status(401).json({
        error: {
          message: "Unauthorized"
        }
      });
    }

    const apiKey =
      "cr_" +
      crypto.randomBytes(24).toString("hex");

    await pool.query(
      `INSERT INTO api_keys
       ("key", balance, total_tokens, active)
       VALUES ($1, $2, $3, $4)`,
      [apiKey, 0, 0, true]
    );

    res.json({
      success: true,
      api_key: apiKey
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: {
        message: "Failed to create API key"
      }
    });
  }
});

app.post("/admin/add-balance", async (req, res) => {
  try {
    if (!checkAdmin(req)) {
      return res.status(401).json({
        error: {
          message: "Unauthorized"
        }
      });
    }

    const {
      api_key,
      amount,
      note
    } = req.body;

    const addAmount = Number(amount);

    if (
      !api_key ||
      !Number.isFinite(addAmount) ||
      addAmount <= 0
    ) {
      return res.status(400).json({
        error: {
          message:
            "Invalid API key or amount"
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
         RETURNING balance`,
        [addAmount, api_key]
      );

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: {
            message: "API key not found"
          }
        });
      }

      await client.query(
        `INSERT INTO balance_transactions
         (api_key, amount, type, note)
         VALUES ($1, $2, $3, $4)`,
        [
          api_key,
          addAmount,
          "topup",
          note || "Admin top-up"
        ]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        balance:
          Number(result.rows[0].balance)
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
        message: "Failed to add balance"
      }
    });
  }
});

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
      `SELECT balance, active
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

    res.json({
      balance:
        Number(result.rows[0].balance),
      active:
        result.rows[0].active
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: {
        message: "Failed to get balance"
      }
    });
  }
});

app.post("/admin/disable-key", async (req, res) => {
  try {
    if (!checkAdmin(req)) {
      return res.status(401).json({
        error: {
          message: "Unauthorized"
        }
      });
    }

    const { api_key } = req.body;

    if (!api_key) {
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
       RETURNING "key"`,
      [api_key]
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
      message: "API key disabled"
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: {
        message: "Failed to disable key"
      }
    });
  }
});

app.post("/v1/chat/completions", async (req, res) => {
  let reservedBalance = 0;
  let reservationKey = null;

  try {
    if (!DASHSCOPE_API_KEY) {
      return res.status(500).json({
        error: {
          message:
            "DASHSCOPE_API_KEY is not configured"
        }
      });
    }

    if (!DATABASE_URL) {
      return res.status(500).json({
        error: {
          message:
            "DATABASE_URL is not configured"
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

    if (!Array.isArray(messages)) {
      return res.status(400).json({
        error: {
          message:
            "messages must be an array"
        }
      });
    }

    if (messages.length === 0) {
      return res.status(400).json({
        error: {
          message:
            "messages cannot be empty"
        }
      });
    }

    const inputCharacters =
      messages.reduce((total, message) => {
        if (!message) return total;

        if (
          typeof message.content === "string"
        ) {
          return total + message.content.length;
        }

        if (
          Array.isArray(message.content)
        ) {
          return (
            total +
            message.content.reduce(
              (sum, item) => {
                if (
                  typeof item === "string"
                ) {
                  return sum + item.length;
                }

                if (
                  item &&
                  typeof item.text ===
                    "string"
                ) {
                  return (
                    sum +
                    item.text.length
                  );
                }

                return sum;
              },
              0
            )
          );
        }

        return total;
      }, 0);

    if (
      inputCharacters >
      MAX_INPUT_CHARS
    ) {
      return res.status(413).json({
        error: {
          message:
            "Request is too large"
        }
      });
    }

    const safeMaxTokens =
      Math.min(
        Math.max(
          Number(max_tokens) || 4096,
          1
        ),
        MAX_OUTPUT_TOKENS
      );

    const estimatedInputTokens =
      Math.max(
        estimateInputTokens(messages),
        1
      );

    const estimatedMaximumCost =
      calculateCost(
        Math.ceil(
          estimatedInputTokens * 1.25
        ),
        safeMaxTokens
      );

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      const reserveResult =
        await client.query(
          `UPDATE api_keys
           SET balance = 0,
               updated_at = now()
           WHERE "key" = $1
             AND active = true
             AND balance >= $2
           RETURNING balance + $2 AS original_balance`,
          [
            apiKey,
            estimatedMaximumCost
          ]
        );

      if (
        reserveResult.rows.length === 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(402).json({
          error: {
            message:
              "Insufficient balance for this request"
          }
        });
      }

      const originalBalance =
        Number(
          reserveResult.rows[0]
            .original_balance
        );

      reservedBalance =
        originalBalance;

      reservationKey = apiKey;

      await client.query(
        `INSERT INTO balance_transactions
         (api_key, amount, type, note)
         VALUES ($1, $2, $3, $4)`,
        [
          apiKey,
          -reservedBalance,
          "reservation",
          "Temporary API request reservation"
        ]
      );

      await client.query(
        "COMMIT"
      );

    } catch (error) {

      await client.query(
        "ROLLBACK"
      );

      throw error;

    } finally {
      client.release();
    }

    const upstreamBody = {
      model,
      messages,
      max_tokens:
        safeMaxTokens
    };

    if (
      typeof temperature === "number"
    ) {
      upstreamBody.temperature =
        temperature;
    }

    let response;

    try {
      response = await fetch(
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "Authorization":
              `Bearer ${DASHSCOPE_API_KEY}`
          },

          body:
            JSON.stringify(
              upstreamBody
            )
        }
      );

    } catch (error) {

      const refundClient =
        await pool.connect();

      try {
        await refundClient.query(
          "BEGIN"
        );

        await refundClient.query(
          `UPDATE api_keys
           SET balance = balance + $1,
               updated_at = now()
           WHERE "key" = $2`,
          [
            reservedBalance,
            reservationKey
          ]
        );

        await refundClient.query(
          `INSERT INTO balance_transactions
           (api_key, amount, type, note)
           VALUES ($1, $2, $3, $4)`,
          [
            reservationKey,
            reservedBalance,
            "refund",
            "Upstream request failed"
          ]
        );

        await refundClient.query(
          "COMMIT"
        );

      } catch (refundError) {

        await refundClient.query(
          "ROLLBACK"
        );

        console.error(
          refundError
        );

      } finally {
        refundClient.release();
      }

      return res.status(502).json({
        error: {
          message:
            "Upstream API request failed"
        }
      });
    }

    let data;

    try {
      data = await response.json();
    } catch (error) {

      const refundClient =
        await pool.connect();

      try {
        await refundClient.query(
          "BEGIN"
        );

        await refundClient.query(
          `UPDATE api_keys
           SET balance = balance + $1,
               updated_at = now()
           WHERE "key" = $2`,
          [
            reservedBalance,
            reservationKey
          ]
        );

        await refundClient.query(
          `INSERT INTO balance_transactions
           (api_key, amount, type, note)
           VALUES ($1, $2, $3, $4)`,
          [
            reservationKey,
            reservedBalance,
            "refund",
            "Invalid upstream response"
          ]
        );

        await refundClient.query(
          "COMMIT"
        );

      } catch (refundError) {

        await refundClient.query(
          "ROLLBACK"
        );

        console.error(
          refundError
        );

      } finally {
        refundClient.release();
      }

      return res.status(502).json({
        error: {
          message:
            "Invalid upstream response"
        }
      });
    }

    if (!response.ok) {

      const refundClient =
        await pool.connect();

      try {
        await refundClient.query(
          "BEGIN"
        );

        await refundClient.query(
          `UPDATE api_keys
           SET balance = balance + $1,
               updated_at = now()
           WHERE "key" = $2`,
          [
            reservedBalance,
            reservationKey
          ]
        );

        await refundClient.query(
          `INSERT INTO balance_transactions
           (api_key, amount, type, note)
           VALUES ($1, $2, $3, $4)`,
          [
            reservationKey,
            reservedBalance,
            "refund",
            "Upstream API returned an error"
          ]
        );

        await refundClient.query(
          "COMMIT"
        );

      } catch (refundError) {

        await refundClient.query(
          "ROLLBACK"
        );

        console.error(
          refundError
        );

      } finally {
        refundClient.release();
      }

      return res
        .status(response.status)
        .json(data);
    }

    const inputTokens =
      Number(
        data?.usage?.prompt_tokens || 0
      );

    const outputTokens =
      Number(
        data?.usage?.completion_tokens || 0
      );

    const totalTokens =
      Number(
        data?.usage?.total_tokens || 0
      );

    const actualCost =
      calculateCost(
        inputTokens,
        outputTokens
      );

    if (
      actualCost >
      reservedBalance
    ) {

      const refundClient =
        await pool.connect();

      try {
        await refundClient.query(
          "BEGIN"
        );

        await refundClient.query(
          `INSERT INTO balance_transactions
           (api_key, amount, type, note)
           VALUES ($1, $2, $3, $4)`,
          [
            reservationKey,
            0,
            "usage",
            "Request exceeded reserved amount"
          ]
        );

        await refundClient.query(
          "COMMIT"
        );

      } catch (logError) {

        await refundClient.query(
          "ROLLBACK"
        );

        console.error(
          logError
        );

      } finally {
        refundClient.release();
      }

      return res.status(500).json({
        error: {
          message:
            "Request exceeded the reserved billing amount"
        }
      });
    }

    const refundAmount =
      Number(
        (
          reservedBalance -
          actualCost
        ).toFixed(6)
      );

    const finalClient =
      await pool.connect();

    try {
      await finalClient.query(
        "BEGIN"
      );

      if (refundAmount > 0) {
        await finalClient.query(
          `UPDATE api_keys
           SET balance = balance + $1,
               total_tokens =
                 total_tokens + $2,
               updated_at = now()
           WHERE "key" = $3`,
          [
            refundAmount,
            totalTokens,
            reservationKey
          ]
        );

        await finalClient.query(
          `INSERT INTO balance_transactions
           (api_key, amount, type, note)
           VALUES ($1, $2, $3, $4)`,
          [
            reservationKey,
            refundAmount,
            "refund",
            "Unused request reservation"
          ]
        );

      } else {

        await finalClient.query(
          `UPDATE api_keys
           SET total_tokens =
                 total_tokens + $1,
               updated_at = now()
           WHERE "key" = $2`,
          [
            totalTokens,
            reservationKey
          ]
        );
      }

      await finalClient.query(
        `INSERT INTO usage_logs
         (api_key, model,
          input_tokens,
          output_tokens,
          cost)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          reservationKey,
          model,
          inputTokens,
          outputTokens,
          actualCost
        ]
      );

      await finalClient.query(
        `INSERT INTO balance_transactions
         (api_key, amount, type, note)
         VALUES ($1, $2, $3, $4)`,
        [
          reservationKey,
          -actualCost,
          "usage",
          `${model} API usage`
        ]
      );

      const balanceResult =
        await finalClient.query(
          `SELECT balance
           FROM api_keys
           WHERE "key" = $1`,
          [reservationKey]
        );

      await finalClient.query(
        "COMMIT"
      );

      const remainingBalance =
        Number(
          balanceResult.rows[0]
            .balance
        );

      data.billing = {
        input_tokens:
          inputTokens,

        output_tokens:
          outputTokens,

        total_tokens:
          totalTokens,

        cost_rm:
          actualCost,

        remaining_balance_rm:
          remainingBalance
      };

      reservedBalance = 0;
      reservationKey = null;

      return res.json(data);

    } catch (error) {

      await finalClient.query(
        "ROLLBACK"
      );

      throw error;

    } finally {
      finalClient.release();
    }

  } catch (error) {

    console.error(error);

    if (
      reservedBalance > 0 &&
      reservationKey
    ) {
      try {

        const refundClient =
          await pool.connect();

        try {
          await refundClient.query(
            "BEGIN"
          );

          await refundClient.query(
            `UPDATE api_keys
             SET balance = balance + $1,
                 updated_at = now()
             WHERE "key" = $2`,
            [
              reservedBalance,
              reservationKey
            ]
          );

          await refundClient.query(
            `INSERT INTO balance_transactions
             (api_key, amount,
              type, note)
             VALUES ($1, $2, $3, $4)`,
            [
              reservationKey,
              reservedBalance,
              "refund",
              "Server error refund"
            ]
          );

          await refundClient.query(
            "COMMIT"
          );

        } catch (refundError) {

          await refundClient.query(
            "ROLLBACK"
          );

          console.error(
            refundError
          );

        } finally {
          refundClient.release();
        }

      } catch (refundConnectionError) {
        console.error(
          refundConnectionError
        );
      }
    }

    res.status(500).json({
      error: {
        message:
          "Relay server error",
        details:
          error.message
      }
    });
  }
});

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Codex Relay running on port ${PORT}`
    );
  }
);
