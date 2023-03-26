import React, { Component } from "react";
import UserDataService from "../../services/user.service";
import { withRouter } from '../common/with-router';

class User extends Component {
    constructor(props) {
        super(props);
        this.onChangeEmail = this.onChangeEmail.bind(this);
        this.updateUser = this.updateUser.bind(this);
        this.deleteUser = this.deleteUser.bind(this);

        this.state = {
            currentUser: {
                id: null,
                email: "",
                greenhouseId: ""
            },
            message: ""
        };
    }

    componentDidMount() {
        this.getPlant(this.props.router.params.id);
    }

    onChangeEmail(e) {
        const email = e.target.value;

        this.setState(function(prevState) {
            return {
                currentUser: {
                    ...prevState.currentUser,
                    email: email
                }
            };
        });
    }

    getUser(id) {
        UserDataService.get(id)
            .then(response => {
                this.setState({
                    currentUser: response.data
                });
                console.log(response.data);
            })
            .catch(e => {
                console.log(e);
            });
    }

    updateUser() {
        UserDataService.update(
            this.state.currentUser.id,
            this.state.currentUser
        )
            .then(response => {
                console.log(response.data);
                this.setState({
                    message: "The family member's info was updated successfully!"
                });
            })
            .catch(e => {
                console.log(e);
            });
    }

    deleteUser() {
        UserDataService.delete(this.state.currentUser.id)
            .then(response => {
                console.log(response.data);
                this.props.router.navigate('/users');
            })
            .catch(e => {
                console.log(e);
            });
    }

    render() {
        const { currentUser } = this.state;

        return (
            <div>
                {currentUser ? (
                    <div className="edit-form">
                        <h4>User</h4>

                        <button
                            className="badge badge-danger mr-2"
                            onClick={this.deletePlant}
                        >
                            Delete
                        </button>

                        <button
                            type="submit"
                            className="badge badge-success"
                            onClick={this.updatePlant}
                        >
                            Update
                        </button>
                        <p>{this.state.message}</p>
                    </div>
                ) : (
                    <div>
                        <br />
                        <p>Select a plant</p>
                    </div>
                )}
            </div>
        );
    }
}

export default withRouter(Plant);