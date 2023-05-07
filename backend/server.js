const express = require("express");
const path = require('path');
const cors = require("cors");
const dotenv = require("dotenv");

const app = express();

dotenv.config();

const db = require("./app/models");
db.sequelize.sync();

var corsOptions = {
    origin: process.env.CORS_ORIGIN
};

app.use(cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

db.sequelize.sync()
    .then(() => {
        console.log("Synced db.");
    })
    .catch((err) => {
        console.log("Failed to sync db: " + err.message);
    });

// Serve the frontend build output as static files
const frontendDistPath = path.join(__dirname, 'dist');
app.use(express.static(frontendDistPath));

require("./app/routes/plant.routes")(app);
require("./app/routes/user.routes")(app);

// If no other routes match, serve the frontend index.html file
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
});

// set port, listen for requests
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}.`);
});
