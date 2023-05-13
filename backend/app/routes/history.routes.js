const plants = require("../controllers/plant.controller");
module.exports = app => {
    const events = require("../controllers/history.controller.js");

    var router = require("express").Router();

    router.get("/", events.findAll);

    router.put("/:id", events.update);

    router.delete("/:id", events.delete);

    router.get("/history", events.findAll);

    app.use("/api/history", router);
};
