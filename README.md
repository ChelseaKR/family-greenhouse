# Family Greenhouse

Grow together effortlessly with our family-friendly plant care app.

## Project setup

Use `npm` to install the project dependencies:

```bash
npm install
```

## Configuration

### Configure credentials

The project must be configured with Auth0 domain and client ID in order for authentication to work.

To do so, copy `src/auth_config.json.example` to a new file in the same folder called `src/auth_config.json` and replace the values with your own Auth0 application credentials.

```json
{
  "domain": "{YOUR AUTH0 DOMAIN}",
  "clientId": "{YOUR AUTH0 CLIENT ID}",
  "audience": "{YOUR AUTH0 API_IDENTIFIER}",
}
```

## Run the application

### Locally

```bash
npm run dev
```

## Deployment

### Compiles and minifies for production

```bash
npm run build
```

### Run your tests

```bash
npm run test
```