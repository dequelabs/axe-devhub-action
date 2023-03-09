import { defineConfig } from "cypress";
import { cypressConfig } from "@axe-core/watcher";
import assert from "assert";

const { SERVER_URL, API_KEY } = process.env;

assert(SERVER_URL, "SERVER_URL is required");
assert(API_KEY, "API_KEY is required");

export default defineConfig(
  cypressConfig({
    axe: {
      apiKey: API_KEY,
      serverURL: SERVER_URL,
    },
    e2e: {
      specPattern: "./test/*.test.ts",
      supportFile: "./test/support.ts",
    },
  })
);
