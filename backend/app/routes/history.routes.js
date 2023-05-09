module.exports = app => {
    const events = require("../controllers/history.controller.js");

    var router = require("express").Router();

    router.get("/", events.findAll);

/*    router.get("/:id", events.findOne);

    router.put("/:id", events.update);*/

   router.get("/history", events.findAll);

    app.use("/api/history", router);
};
