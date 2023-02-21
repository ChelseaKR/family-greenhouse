module.exports = app => {
    const plants = require("../controllers/plant.controller.js");

    var router = require("express").Router();

    router.post("/add", plants.create);

    router.get("/", plants.findAll);

    router.get("/:id", plants.findOne);

    router.put("/:id", plants.update);

    router.delete("/:id", plants.delete);

    router.delete("/", plants.deleteAll);

    app.use("/api/plants", router);
};
