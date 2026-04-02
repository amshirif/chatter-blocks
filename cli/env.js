import { readFileSync } from "node:fs";
import path from "node:path";

function stripWrappingQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseDotEnv(contents) {
  const entries = {};

  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const rawKey = line.slice(0, equalsIndex).trim();
    if (!rawKey) {
      continue;
    }

    let rawValue = line.slice(equalsIndex + 1).trim();
    rawValue = stripWrappingQuotes(rawValue);
    entries[rawKey] = rawValue;
  }

  return entries;
}

export function loadDotEnv({ cwd = process.cwd(), filename = ".env" } = {}) {
  const envPath = path.join(cwd, filename);

  try {
    const parsed = parseDotEnv(readFileSync(envPath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }

    return {
      loaded: true,
      path: envPath,
      values: parsed
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        loaded: false,
        path: envPath,
        values: {}
      };
    }

    throw error;
  }
}

export function loadDotEnvForCurrentProcess() {
  return loadDotEnv();
}
