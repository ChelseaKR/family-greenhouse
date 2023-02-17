import React from "react";

import logo from "../assets/logo.svg";

const Hero = () => (
  <div className="text-center hero my-5">
    <img className="mb-3 app-logo" src={logo} alt="Family Greenhouse" width="120" />
    <h1 className="mb-4">Family Greenhouse</h1>

    <p className="lead">
        Grow together effortlessly with our family-friendly plant care app.
    </p>
  </div>
);

export default Hero;
