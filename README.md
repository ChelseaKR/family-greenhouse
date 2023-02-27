# Family Greenhouse

<div id="top" align="center">
  Family Greenhouse: Grow together effortlessly with this family-friendly plant care app.
</div>

## Table of Contents

<ul>
  <li><a href="#Why-Family-Greenhouse">Why Family Greenhouse</a></li>
  <li><a href="#Project-Setup">Project setup</a></li>
</ul>


## Why Family Greenhouse

Family Greenhouse is an application that allows families to coordinate the care of household plants with one another. It demonstrates the sole developer’s capabilities in software engineering project management, execution, and presentation over a brief amount of time (about three months under part-time development). It uses the React web framework, a Node.js web server, a PostgreSQL database, and various Amazon Web Services APIs.

Family Greenhouse's key features include setting device push notifications and email reminders for plant maintenance tasks. Depending on the user’s needs, they can establish themselves as a “head of household” role for their house and invite other family members to join, or they may accept an invite to join accounts to manage the same household. Use cases include receiving reminders to water plants while also tracking whether another household member has already watered them - preventing plants from being overwatered. The goal of the application is to enable users to keep their plants better cared for, for longer.

Using Scrum software development methodology and industry-standard techniques in requirements engineering, user research, and quality assurance, the project serves as an alpha version of what could someday evolve into a product with long-term support for an active, global user base. Future work may involve integrating with third-party services for plant identification, social media features, and connecting with specialists to receive plant care advice over video conversations.

## Project setup

Before starting the project for the first time:

1. Run the install script
2. 
```bash
./scripts/install-all.sh
```

2. The project must be configured with Auth0 domain and client ID in order for authentication to work. To do so, copy `src/auth_config.json.example` to a new file in the same folder called `src/auth_config.json` and replace the values with your own Auth0 application credentials.

```json
{
  "domain": "{YOUR AUTH0 DOMAIN}",
  "clientId": "{YOUR AUTH0 CLIENT ID}",
  "audience": "{YOUR AUTH0 API_IDENTIFIER}",
}

```

## Run the application

### Locally

In one terminal, start backend server:

`./scripts/backend-start.sh`

In another terminal window, start frontend server. It should automatically open up `localhost:8081` in your browser.

`./scripts/frontend-start.sh`

## Deployment

### Compiles and minifies for production

```bash
npm run build
```

### Run your tests

```bash
npm run test
```

## Third-party APIs
- [Amazon Simple Email Service (AWS)](https://aws.amazon.com/sns/) - Device notifications and email reminders
- [Auth0](https://auth0.com/) - Identity and Access Management provider
- [Perenual](https://perenual.com/) - For listing plant species + species info
