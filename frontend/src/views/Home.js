import React, { Fragment } from "react";

import Hero from "../components/common/Hero";
import {useAuth0} from "@auth0/auth0-react";
import {Button, NavItem} from "reactstrap";
import PlantsList from "../components/plants/plants-list.component";

const Home = () => {
    const {
        isAuthenticated,
    } = useAuth0();
    return (
        <Fragment>
            {!isAuthenticated && (
                <Hero />
            )}

            {isAuthenticated && (
                <PlantsList />
            )}
            <hr />
        </Fragment>
    )

};

export default Home;
