import "mocha";
import "@axe-core/watcher/dist/cypressCommands";
import { wrapCy } from "@axe-core/watcher/dist/cypress";

before(() => {
  wrapCy(cy);
});

afterEach(() => {
  cy.axeFlush();
});
