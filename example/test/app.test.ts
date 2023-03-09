import "mocha";

describe("App", () => {
  describe("home page", () => {
    it("has a title", () => {
      cy.visit("http://localhost:5012").title().should("eq", "Home | App");
    });

    it("has links in the header", () => {
      cy.visit("http://localhost:5012");
      cy.get("header").should("exist");
      cy.get('header a[href="/violations"]').should("exist").click();
    });
  });
});
