import React, { Component } from "react";
import UserDataService from "../../services/user.service";

import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { withAuth0 } from "@auth0/auth0-react";

export class UsersList extends Component {
    constructor(props) {
        super(props);
        this.retrieveUsers = this.retrieveUsers.bind(this);
        this.refreshList = this.refreshList.bind(this);
        this.setActiveUser = this.setActiveUser.bind(this);
        this.removeAllUsers = this.removeAllUsers.bind(this);
        this.searchGreenhouseId = this.searchGreenhouseId.bind(this);

        const { user } = this.props.auth0;
        this.state = {
            greenhouseId: user.greenhouse,
            users: [],
            currentUser: null,
            currentIndex: -1,
        };
    }

    componentDidMount() {
        this.retrieveUsers();
    }

    retrieveUsers() {
        UserDataService.findByGreenhouseId(this.state.greenhouseId)
            .then(response => {
                this.setState({
                    users: response.data
                });
                console.log(response.data);
            })
            .catch(e => {
                console.log(e);
            });
    }

    refreshList() {
        this.retrieveUsers();
        this.setState({
            currentUser: null,
            currentIndex: -1
        });
    }

    setActiveUser(user, index) {
        this.setState({
            currentUser: user,
            currentIndex: index
        });
    }

    removeAllUsers() {
        UserDataService.deleteAll()
            .then(response => {
                console.log(response.data);
                this.refreshList();
            })
            .catch(e => {
                console.log(e);
            });
    }

    searchGreenhouseId() {
        this.setState({
            currentUser: null,
            currentIndex: -1
        });
        // console.log(this.state.greenhouseId);
        UserDataService.findByGreenhouseId(this.state.greenhouseId)
            .then(response => {
                this.setState({
                    users: response.data
                });
                console.log(response.data);
            })
            .catch(e => {
                console.log(e);
            });
    }

    render() {
        const { users, currentUser, currentIndex } = this.state;

        return (
            <div className="list row">
                <div className="col-md-12">
                    <h4>Family List
                        <a
                            className="btn btn-sm btn-success" style={{float: "right"}}
                            href="/users/add"
                        >
                            <FontAwesomeIcon icon="plus" className="mr-1" /> Add Family!
                        </a></h4>
                    <ul className="list-group">
                        {users && users.map((user, index) => (
                            <li
                                className={ "list-group-item " +  (index === currentIndex ? "active" : "")  }
                                onClick={() => this.setActiveUser(user, index)}
                                key={index}
                            >
                                {user.name}
                                <br></br>

{/*                                <Link
                                    to={"/users/" + user.sub}
                                    className="badge badge-warning"
                                >
                                    Edit
                                </Link>*/}
                            </li>
                        ))}
                    </ul>
                    {/*                    <button
                        className="m-3 btn btn-sm btn-danger"
                        onClick={this.removeAllUsers}
                    >
                        Remove All
                    </button>*/}
                </div>
            </div>
        );
    }
}

export default withAuth0(UsersList)