const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '/frontend/.env') });

Cypress.Commands.add('login', (client_id, client_secret, email, password) => {
    console.log('Domain: ', Cypress.env('REACT_APP_AUTH0_DOMAIN'));
    console.log('Audience: ', Cypress.env('REACT_APP_AUTH0_AUDIENCE'));

    cy.request({
        method: 'POST',
        url: `https://${Cypress.env('REACT_APP_AUTH0_DOMAIN')}/oauth/token`,
        body: {
            grant_type: 'password',
            username: email,
            password: password,
            audience: Cypress.env('REACT_APP_AUTH0_AUDIENCE'),
            scope: 'openid profile email',
            client_id: client_id,
            client_secret: client_secret,
        },
    }).then(({ body }) => {
        const { access_token, expires_in, id_token } = body;

        cy.server();

        // If you're using local storage to store the tokens
        window.localStorage.setItem('access_token', access_token);
        window.localStorage.setItem('id_token', id_token);
        window.localStorage.setItem('expires_at', expires_in);

        cy.route({
            url: 'https://**/userinfo',
            response: {
                email: email,
                email_verified: true,
                sub: 'auth0|000000000000000000000000',
            },
        }).as('getUserInfo');
    });
});
