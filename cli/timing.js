import { performance } from "node:perf_hooks";
import { stderr } from "node:process";

function formatDuration(durationMs) {
  return `${Math.round(durationMs)}ms`;
}

export function isTimingEnabled() {
  return process.env.CHATTER_TIMING === "1";
}

export function emitTimingLine(label, spans = {}, { totalMs = null, writer = stderr, enabled = isTimingEnabled() } = {}) {
  if (!enabled) {
    return;
  }

  const parts = [`timing ${label}`];
  if (totalMs !== null) {
    parts.push(`total=${formatDuration(totalMs)}`);
  }

  for (const [name, durationMs] of Object.entries(spans)) {
    if (durationMs === null || durationMs === undefined) {
      continue;
    }

    parts.push(`${name}=${formatDuration(durationMs)}`);
  }

  writer.write(`${parts.join(" ")}\n`);
}

export function createTimingReport(label, { writer = stderr, enabled = isTimingEnabled() } = {}) {
  const startedAt = performance.now();
  const spans = {};

  return {
    async measure(name, fn) {
      if (!enabled) {
        return await fn();
      }

      const spanStart = performance.now();
      try {
        return await fn();
      } finally {
        spans[name] = performance.now() - spanStart;
      }
    },
    flush(extraSpans = {}) {
      if (!enabled) {
        return;
      }

      emitTimingLine(label, { ...spans, ...extraSpans }, {
        totalMs: performance.now() - startedAt,
        writer,
        enabled
      });
    }
  };
}

export async function timeAsync(label, fn, { writer = stderr, enabled = isTimingEnabled() } = {}) {
  if (!enabled) {
    return await fn();
  }

  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    emitTimingLine(label, {}, {
      totalMs: performance.now() - startedAt,
      writer,
      enabled
    });
  }
}
