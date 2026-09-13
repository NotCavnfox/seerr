describe('General Settings', () => {
  let originalTrustProxy: boolean | undefined;

  beforeEach(() => {
    originalTrustProxy = undefined;
    cy.loginAsAdmin();
    cy.request('/api/v1/settings/network').then(({ body }) => {
      originalTrustProxy = body.trustProxy;
    });
  });

  afterEach(() => {
    // Restore server state even when an assertion fails before the UI cleanup.
    // Cypress resets browser sessions between tests, but the server stays alive.
    if (originalTrustProxy !== undefined) {
      cy.request('POST', '/api/v1/settings/network', {
        trustProxy: originalTrustProxy,
      })
        .its('status')
        .should('eq', 200);
    }
  });

  it('opens the settings page from the home page', () => {
    cy.visit('/');

    cy.get('[data-testid=sidebar-toggle]').click();
    cy.get('[data-testid=sidebar-menu-settings-mobile]').click();

    cy.get('.heading').should('contain', 'General Settings');
  });

  it('modifies setting that requires restart', () => {
    cy.intercept('POST', '/api/v1/settings/network').as('saveNetwork');
    cy.intercept('GET', '/api/v1/status?checkUpdateAvailable=false').as(
      'status'
    );
    cy.visit('/settings/network');
    cy.wait('@status').its('response.body.restartRequired').should('eq', false);

    cy.get('#trustProxy').click();
    cy.get('[data-testid=settings-network-form]').submit();
    cy.wait('@saveNetwork').its('response.statusCode').should('eq', 200);
    cy.wait('@status').its('response.body.restartRequired').should('eq', true);
    cy.get('[data-testid=modal-title]').should(
      'contain',
      'Server Restart Required'
    );

    cy.get('[data-testid=modal-ok-button]').click();
    cy.get('[data-testid=modal-title]').should('not.exist');

    cy.get('[type=checkbox]#trustProxy').click();
    cy.get('[data-testid=settings-network-form]').submit();
    cy.wait('@saveNetwork').its('response.statusCode').should('eq', 200);
    cy.wait('@status').its('response.body.restartRequired').should('eq', false);
    cy.get('[data-testid=modal-title]').should('not.exist');

    // A fresh page must not reopen the restart prompt for later specs.
    cy.reload();
    cy.wait('@status').its('response.body.restartRequired').should('eq', false);
    cy.get('[data-testid=modal-title]').should('not.exist');
  });
});
