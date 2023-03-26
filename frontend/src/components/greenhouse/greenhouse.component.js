import React, { Component } from "react";
import PlantDataService from "../../services/plant.service";
import { withRouter } from '../common/with-router';
import UsersListComponent from "./users-list.component";

class Plant extends Component {

    render() {
        const { currentPlant } = this.state;

        return (
            <UsersListComponent></UsersListComponent>
        );
    }
}

export default withRouter(Plant);