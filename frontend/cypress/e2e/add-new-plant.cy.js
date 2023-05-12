describe("Add Plant", () => {
    beforeEach(() => {
        cy.login(
            Cypress.env('REACT_APP_AUTH0_CLIENTID'),
            Cypress.env('REACT_APP_AUTH0_CLIENTSECRET'),
            Cypress.env('REACT_APP_AUTH0_TEST_USER_EMAIL'),
            Cypress.env('REACT_APP_AUTH0_TEST_USER_PASSWORD')
        );
    });

    it("adds a new plant", () => {
        cy.visit("/");
        cy.get('[href="/plants/add"]').click();
        cy.url().should("include", "/plants/add");

        cy.get("#name").type("Test Plant");
        cy.get("#type").type("Test Type");
        cy.get("#location").type("Test Location");
        cy.get("#description").type("Test Description");

        cy.get("#days")
            .select("7")
            .should("have.value", "7");

        cy.get("button.btn.btn-success").click();

        cy.contains("Your plant has been added successfully!").should("be.visible");
    });
});