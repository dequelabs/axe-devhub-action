import "mocha";
import "@axe-core/watcher/dist/cypressCommands";

afterEach(() => {
  cy.axeFlush();
});
