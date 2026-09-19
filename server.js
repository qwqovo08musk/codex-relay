const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Admin-Secret"
  );
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const PORT = process.env.PORT || 3000;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/*
  Customer pricing in RM

  Customer price:
  Input  = RM 0.02 / 1K tokens
  Output = RM 0.15 / 1K tokens
*/

const INPUT_PRICE_PER_1K = 0.02;
const OUTPUT_PRICE_PER_1K = 0.15;

const MAX_INPUT_CHARS = 500000;
const MAX_OUTPUT_TOKENS = 8192;

function calculateCost(inputTokens, outputTokens) {
  const inputCost =
    (Number(inputTokens || 0) / 1000) * INPUT_PRICE_PER_1K;

  const outputCost =
    (Number(outputTokens || 0) / 1000) * OUTPUT_PRICE_PER_1K;

  return Number((inputCost + outputCost).toFixed(6));
}

function estimateInputTokens(messages) {
  let chars = 0;

  for (const message of messages || []) {
    if (typeof message.content === "string") {
      chars += message.content.length;
    } else {
      chars += JSON.stringify(message.content || "").length;
    }
  }

  // Conservative estimate for Chinese / English mixed text
  return Math.ceil(chars / 2);
}

function generateCustomerKey() {
  return (
    "cr_" +
    crypto.randomBytes(24).toString("hex")
  );
}

function getCustomerKey(req) {
  const auth = req.headers.authorization || "";

  if (auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }

  if (req.body && req.body.api_key) {
    return String(req.body.api_key).trim();
  }

  return "";
}

function checkAdmin(req) {
  const secret = req.headers["x-admin-secret"];

  return (
    typeof secret === "string" &&
    secret === ADMIN_SECRET
  );
}

/* =========================
   Health check
========================= */

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Codex Relay API is running"
  });
});

/* =========================
   Create customer API key
========================= */

app.post("/admin/create-key", async (req, res) => {
  try {
    if (!checkAdmin(req)) {
      return res.status(401).json({
        error: {
          message: "Unauthorized"
        }
      });
    }

    const key = generateCustomerKey();

    const result = await pool.query(
      `
      INSERT INTO api_keys
        ("key", balance, total_tokens, active)
      VALUES
        ($1, 0, 0, true)
      RETURNING
        "key",
        balance,
        total_tokens,
        active,
        created_at
      `,
      [key]
    );

    res.json({
      success: true,
      key: result.rows[0]
    });
  } catch (error) {
    console.error("create-key error:", error);

    res.status(500).json({
      error: {
        message: "Failed to create API key",
        details: error.message
      }
    });
  }
});

/* =========================
   Add customer balance
========================= */

app.post("/admin/add-balance", async (req, res) => {
  try {
    if (!checkAdmin(req)) {
      return res.status(401).json({
        error: {
          message: "Unauthorized"
        }
      });
    }

    const apiKey = String(req.body.api_key || "").trim();
    const amount = Number(req.body.amount || 0);
    const note = req.body.note
      ? String(req.body.note)
      : null;

    if (!apiKey) {
      return res.status(400).json({
        error: {
          message: "api_key is required"
        }
      });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: {
          message: "amount must be greater than 0"
        }
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const update = await client.query(
        `
        UPDATE api_keys
        SET
          balance = balance + $2,
          updated_at = now()
        WHERE
          "key" = $1
          AND active = true
        RETURNING
          balance
        `,
        [apiKey, amount]
      );

      if (update.rowCount === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: {
            message: "Customer API key not found or disabled"
          }
        });
      }

      await client.query(
        `
        INSERT INTO balance_transactions
          (api_key, amount, type, note)
        VALUES
          ($1, $2, 'topup', $3)
        `,
        [apiKey, amount, note]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        balance: Number(update.rows[0].balance)
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("add-balance error:", error);

    res.status(500).json({
      error: {
        message: "Failed to add balance",
        details: error.message
      }
    });
  }
});

/* =========================
   Check customer balance
========================= */

app.get("/v1/balance", async (req, res) => {
  try {
    const apiKey = getCustomerKey(req);

    if (!apiKey) {
      return res.status(401).json({
        error: {
          message: "API key is required"
        }
      });
    }

    const result = await pool.query(
      `
      SELECT
        balance,
        total_tokens,
        active
      FROM api_keys
      WHERE "key" = $1
      `,
      [apiKey]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({
        error: {
          message: "Invalid API key"
        }
      });
    }

    const customer = result.rows[0];

    if (!customer.active) {
      return res.status(403).json({
        error: {
          message: "API key is disabled"
        }
      });
    }

    res.json({
      balance: Number(customer.balance),
      total_tokens: Number(customer.total_tokens || 0),
      active: customer.active
    });
  } catch (error) {
    console.error("balance error:", error);

    res.status(500).json({
      error: {
        message: "Failed to get balance",
        details: error.message
      }
    });
  }
});

/* =========================
   Disable customer key
========================= */

app.post("/admin/disable-key", async (req, res) => {
  try {
    if (!checkAdmin(req)) {
      return res.status(401).json({
        error: {
          message: "Unauthorized"
        }
      });
    }

    const apiKey = String(req.body.api_key || "").trim();

    if (!apiKey) {
      return res.status(400).json({
        error: {
          message: "api_key is required"
        }
      });
    }

    const result = await pool.query(
      `
      UPDATE api_keys
      SET
        active = false,
        updated_at = now()
      WHERE "key" = $1
      RETURNING
        "key",
        active
      `,
      [apiKey]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: {
          message: "Customer API key not found"
        }
      });
    }

    res.json({
      success: true,
      key: result.rows[0]
    });
  } catch (error) {
    console.error("disable-key error:", error);

    res.status(500).json({
      error: {
        message: "Failed to disable API key",
        details: error.message
      }
    });
  }
});

/* =========================
   Chat completions
========================= */

app.post("/v1/chat/completions", async (req, res) => {
  const client = await pool.connect();

  let reservedCost = 0;
  let apiKey = "";
  let reservationCreated = false;

  try {
    apiKey = getCustomerKey(req);

    if (!apiKey) {
      return res.status(401).json({
        error: {
          message: "API key is required"
        }
      });
    }

    const messages = req.body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "messages is required"
        }
      });
    }

    const inputChars = JSON.stringify(messages).length;

    if (inputChars > MAX_INPUT_CHARS) {
      return res.status(400).json({
        error: {
          message: "Input is too large"
        }
      });
    }

    const model = req.body.model || "qwen3.5-27b";

    const maxTokens = Math.min(
      Number(req.body.max_tokens || MAX_OUTPUT_TOKENS),
      MAX_OUTPUT_TOKENS
    );

    /*
      Estimate maximum possible cost.

      This is only a reservation.
      It is NOT the final charge.
    */

    const estimatedInputTokens =
      estimateInputTokens(messages);

    const maximumPossibleCost =
      calculateCost(
        estimatedInputTokens,
        maxTokens
      );

    if (
      !Number.isFinite(maximumPossibleCost) ||
      maximumPossibleCost <= 0
    ) {
      return res.status(400).json({
        error: {
          message: "Invalid request cost"
        }
      });
    }

    /*
      IMPORTANT:

      Reserve ONLY the estimated maximum cost.

      NEVER set the customer's whole balance to zero.
    */

    await client.query("BEGIN");

    const reservation = await client.query(
      `
      UPDATE api_keys
      SET
        balance = balance - $2,
        updated_at = now()
      WHERE
        "key" = $1
        AND active = true
        AND balance >= $2
      RETURNING
        balance
      `,
      [
        apiKey,
        maximumPossibleCost
      ]
    );

    if (reservation.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(402).json({
        error: {
          message:
            "Insufficient balance for this request"
        }
      });
    }

    reservedCost = maximumPossibleCost;
    reservationCreated = true;

    await client.query(
      `
      INSERT INTO balance_transactions
        (api_key, amount, type, note)
      VALUES
        ($1, $2, 'reservation', $3)
      `,
      [
        apiKey,
        -maximumPossibleCost,
        "Temporary reservation"
      ]
    );

    await client.query("COMMIT");

    /*
      Call Alibaba Cloud only AFTER
      the customer has enough balance reserved.
    */

    if (!DASHSCOPE_API_KEY) {
      throw new Error(
        "DASHSCOPE_API_KEY is not configured"
      );
    }

    const upstreamResponse = await fetch(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization":
            `Bearer ${DASHSCOPE_API_KEY}`
        },
        body: JSON.stringify({
          ...req.body,
          model
        })
      }
    );

    const upstreamText =
      await upstreamResponse.text();

    let upstreamData;

    try {
      upstreamData = JSON.parse(upstreamText);
    } catch {
      upstreamData = null;
    }

    /*
      Upstream failed.
      Refund the reservation.
    */

    if (
      !upstreamResponse.ok ||
      !upstreamData
    ) {
      await pool.query(
        `
        UPDATE api_keys
        SET
          balance = balance + $2,
          updated_at = now()
        WHERE "key" = $1
        `,
        [
          apiKey,
          reservedCost
        ]
      );

      await pool.query(
        `
        INSERT INTO balance_transactions
          (api_key, amount, type, note)
        VALUES
          ($1, $2, 'refund', $3)
        `,
        [
          apiKey,
          reservedCost,
          "Upstream request failed"
        ]
      );

      return res.status(
        upstreamResponse.status || 502
      ).json({
        error: {
          message:
            "Upstream API request failed",
          upstream:
            upstreamData ||
            upstreamText
        }
      });
    }

    /*
      Read actual token usage.
    */

    const usage =
      upstreamData.usage || {};

    const inputTokens =
      Number(
        usage.prompt_tokens ||
        usage.input_tokens ||
        0
      );

    const outputTokens =
      Number(
        usage.completion_tokens ||
        usage.output_tokens ||
        0
      );

    const totalTokens =
      Number(
        usage.total_tokens ||
        inputTokens + outputTokens
      );

    /*
      Final real cost.
    */

    const actualCost =
      calculateCost(
        inputTokens,
        outputTokens
      );

    /*
      Safety check.

      Actual cost should never exceed
      the reservation.

      If it does, don't allow the customer's
      balance to become negative.
    */

    if (actualCost > reservedCost) {
      await pool.query(
        `
        UPDATE api_keys
        SET
          balance = balance + $2,
          updated_at = now()
        WHERE "key" = $1
        `,
        [
          apiKey,
          reservedCost
        ]
      );

      await pool.query(
        `
        INSERT INTO balance_transactions
          (api_key, amount, type, note)
        VALUES
          ($1, $2, 'refund', $3)
        `,
        [
          apiKey,
          reservedCost,
          "Safety refund: actual cost exceeded reservation"
        ]
      );

      return res.status(500).json({
        error: {
          message:
            "Billing safety check failed. Request was refunded."
        }
      });
    }

    /*
      Refund unused reservation.

      Example:

      Reserved = RM0.60
      Actual   = RM0.06
      Refund   = RM0.54
    */

    const refund =
      Number(
        (reservedCost - actualCost)
          .toFixed(6)
      );

    if (refund > 0) {
      await pool.query(
        `
        UPDATE api_keys
        SET
          balance = balance + $2,
          total_tokens = total_tokens + $3,
          updated_at = now()
        WHERE "key" = $1
        `,
        [
          apiKey,
          refund,
          totalTokens
        ]
      );

      await pool.query(
        `
        INSERT INTO balance_transactions
          (api_key, amount, type, note)
        VALUES
          ($1, $2, 'refund', $3)
        `,
        [
          apiKey,
          refund,
          "Unused request reservation"
        ]
      );
    } else {
      await pool.query(
        `
        UPDATE api_keys
        SET
          total_tokens = total_tokens + $2,
          updated_at = now()
        WHERE "key" = $1
        `,
        [
          apiKey,
          totalTokens
        ]
      );
    }

    /*
      Record actual usage.
    */

    await pool.query(
      `
      INSERT INTO usage_logs
        (
          api_key,
          model,
          input_tokens,
          output_tokens,
          cost
        )
      VALUES
        ($1, $2, $3, $4, $5)
      `,
      [
        apiKey,
        model,
        inputTokens,
        outputTokens,
        actualCost
      ]
    );

    /*
      Record actual charge.

      The actual charge is negative.
    */

    if (actualCost > 0) {
      await pool.query(
        `
        INSERT INTO balance_transactions
          (api_key, amount, type, note)
        VALUES
          ($1, $2, 'usage', $3)
        `,
        [
          apiKey,
          -actualCost,
          `Model usage: ${model}`
        ]
      );
    }

    /*
      Get final balance.
    */

    const finalBalance =
      await pool.query(
        `
        SELECT
          balance,
          total_tokens
        FROM api_keys
        WHERE "key" = $1
        `,
        [apiKey]
      );

    const remaining =
      Number(
        finalBalance.rows[0].balance
      );

    /*
      Return the original AI response
      plus billing information.
    */

    res.json({
      ...upstreamData,

      billing: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost: actualCost,
        remaining: remaining
      }
    });
  } catch (error) {
    console.error(
      "chat completion error:",
      error
    );

    /*
      If anything unexpected happens AFTER
      reservation, refund the reservation.

      This prevents the customer from losing
      money when the upstream request fails.
    */

    if (
      reservationCreated &&
      reservedCost > 0 &&
      apiKey
    ) {
      try {
        await pool.query(
          `
          UPDATE api_keys
          SET
            balance = balance + $2,
            updated_at = now()
          WHERE "key" = $1
          `,
          [
            apiKey,
            reservedCost
          ]
        );

        await pool.query(
          `
          INSERT INTO balance_transactions
            (api_key, amount, type, note)
          VALUES
            ($1, $2, 'refund', $3)
          `,
          [
            apiKey,
            reservedCost,
            "Automatic error refund"
          ]
        );
      } catch (refundError) {
        console.error(
          "refund error:",
          refundError
        );
      }
    }

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message:
            "Internal server error",
          details:
            error.message
        }
      });
    }
  } finally {
    client.release();
  }
});

/* =========================
   Start server
========================= */

app.listen(PORT, () => {
  console.log(
    `Codex Relay running on port ${PORT}`
  );
});
