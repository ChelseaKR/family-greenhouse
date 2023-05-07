import React from "react";
import { Button } from "reactstrap";
import { useAuth0 } from '@auth0/auth0-react';

import logo from "../../assets/logo.svg";

const Hero = () => {
    const { loginWithRedirect } = useAuth0();

    const handleSignUp = () => {
        loginWithRedirect({
            screen_hint: 'signup'
        });
    };

    return (
        <div className="text-center hero my-5">
            <img className="mb-3 app-logo" src={logo} alt="Family Greenhouse" width="120" />
            <h1 className="mb-4">Family Greenhouse</h1>

            <p className="lead">
                Grow together effortlessly with our family-friendly plant care app.
                <br />
                <br/>
                <Button
                    color="primary"
                    className="btn-margin"
                    onClick={handleSignUp}
                >
                    Sign up
                </Button>
            </p>
        </div>
    );
};

export default Hero;
