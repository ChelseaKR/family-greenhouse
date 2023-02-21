# Family Greenhouse

Grow together effortlessly with our family-friendly plant care app.

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