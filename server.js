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

function calculateCost(inputTokens, outputTokens) {
  const inputCost =
    (inputTokens / 1000) * INPUT_PRICE_PER_1K;

  const outputCost =
    (outputTokens / 1000) * OUTPUT_PRICE_PER_1K;

  return Number(
    (inputCost + outputCost).toFixed(6)
  );
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

    const keyResult = await pool.query(
      `SELECT "key", balance, active
       FROM api_keys
       WHERE "key" = $1`,
      [apiKey]
    );

    if (keyResult.rows.length === 0) {
      return res.status(401).json({
        error: {
          message: "Invalid API key"
        }
      });
    }

    const keyData =
      keyResult.rows[0];

    if (!keyData.active) {
      return res.status(403).json({
        error: {
          message:
            "API key is disabled"
        }
      });
    }

    const balance =
      Number(keyData.balance);

    if (balance <= 0) {
      return res.status(402).json({
        error: {
          message:
            "Insufficient balance"
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

    const safeMaxTokens =
      Math.min(
        Number(max_tokens) || 4096,
        8192
      );

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

    const response =
      await fetch(
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

    const data =
      await response.json();

    if (!response.ok) {
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

    const cost =
      calculateCost(
        inputTokens,
        outputTokens
      );

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      const deductResult =
        await client.query(
          `UPDATE api_keys
           SET balance = balance - $1,
               total_tokens =
                 total_tokens + $2,
               updated_at = now()
           WHERE "key" = $3
             AND active = true
             AND balance >= $1
           RETURNING balance`,
          [
            cost,
            totalTokens,
            apiKey
          ]
        );

      if (
        deductResult.rows.length === 0
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

      const newBalance =
        Number(
          deductResult
            .rows[0]
            .balance
        );

      await client.query(
        `INSERT INTO usage_logs
         (api_key, model,
          input_tokens,
          output_tokens,
          cost)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          apiKey,
          model,
          inputTokens,
          outputTokens,
          cost
        ]
      );

      await client.query(
        `INSERT INTO balance_transactions
         (api_key, amount,
          type, note)
         VALUES ($1, $2, $3, $4)`,
        [
          apiKey,
          -cost,
          "usage",
          `${model} API usage`
        ]
      );

      await client.query(
        "COMMIT"
      );

      data.billing = {
        input_tokens:
          inputTokens,

        output_tokens:
          outputTokens,

        total_tokens:
          totalTokens,

        cost_rm:
          cost,

        remaining_balance_rm:
          newBalance
      };

      res.json(data);

    } catch (error) {

      await client.query(
        "ROLLBACK"
      );

      throw error;

    } finally {
      client.release();
    }

  } catch (error) {

    console.error(error);

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
