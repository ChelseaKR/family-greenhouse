module.exports = app => {
    const taskItems = require("../controllers/history.controller.js");

    var router = require("express").Router();

    router.post("/add", taskItems.create);

    router.get("/", taskItems.findAll);

    router.get("/:id", taskItems.findOne);

    router.put("/:id", taskItems.update);

    router.delete("/:id", taskItems.delete);

    router.get("/:userId", taskItems.findAll);

    router.delete("/", taskItems.deleteAll);

    app.use("/api/taskItems", router);
};
