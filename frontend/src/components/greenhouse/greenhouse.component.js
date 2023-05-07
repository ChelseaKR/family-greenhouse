import React, { Component } from "react";
import { withRouter } from '../common/with-router';
import UsersListComponent from "./users-list.component";

class Greenhouse extends Component {

    render() {
        return (
            <div>
                <h3>My Greenhouse</h3>
                <br/>
                <UsersListComponent/>
            </div>
        );
    }
}

export default withRouter(Greenhouse);