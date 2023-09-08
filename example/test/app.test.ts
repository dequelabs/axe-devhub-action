import "mocha";

const maximumIssueImpact = Cypress.env("MAXIMUM_ISSUE_IMPACT") ?? "NONE";
const skipMinor = maximumIssueImpact === "NONE";
const skipSerious = maximumIssueImpact === "NONE" || maximumIssueImpact === "MINOR";

describe("App", () => {
  describe("home page", () => {
    it("has a title", () => {
      cy.visit("http://localhost:5012").title().should("eq", "Home | App");
    });

    it("has links in the header", () => {
      cy.visit("http://localhost:5012");
      cy.get("header").should("exist");
      cy.get('header a[href="/violations"]').should("exist");
    });
  });

  (skipMinor ? describe.skip : describe)("minor violations page", () => {
    it("has a title", () => {
      cy.visit("http://localhost:5012/minor-violations")
        .title()
        .should("eq", "Violations | App");
    });

    it("has links in the header", () => {
      cy.visit("http://localhost:5012/minor-violations");
      cy.get("header").should("exist");
      cy.get('header a[href="/"]').should("exist");
    });

    it("has images of cats", () => {
      cy.visit("http://localhost:5012/minor-violations");
      cy.get("img").should("have.length", 10);
    });
  });

  (skipSerious ? describe.skip : describe)("serious violations page", () => {
    it("has a title", () => {
      cy.visit("http://localhost:5012/serious-violations")
        .title()
        .should("eq", "Violations | App");
    });

    it("has links in the header", () => {
      cy.visit("http://localhost:5012/serious-violations");
      cy.get("header").should("exist");
      cy.get('header a[href="/"]').should("exist");
    });

    it("has images of cats", () => {
      cy.visit("http://localhost:5012/serious-violations");
      cy.get("img").should("have.length", 10);
    });
  });
});
