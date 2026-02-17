import { defineConfig } from "cypress";
import { cypressConfig } from "@axe-core/watcher";
import assert from "assert";

const { API_KEY } = "e6786ef2-fdef-46b7-979b-8dbeac61779e";

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
