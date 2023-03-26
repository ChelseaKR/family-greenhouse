import React, { Component } from "react";
import UserDataService from "../../services/user.service";
import { withAuth0 } from '@auth0/auth0-react';

class AddUser extends Component {
    constructor(props) {
        super(props);
        this.onChangeEmail = this.onChangeEmail.bind(this);
        this.saveUser = this.saveUser.bind(this);
        this.newUser = this.newUser.bind(this);

        const { user } = this.props.auth0;
        this.state = {
            email: "",
            greenhouseId: user.greenhouse,

            submitted: false
        };
    }

    onChangeEmail(e) {
        this.setState({
            email: e.target.value
        });
    }

    saveUser() {
        var data = {
            email: this.state.email,
            greenhouseId: this.state.greenhouseId
        };

        UserDataService.create(data)
            .then(response => {
                this.setState({
                    email: response.data.email,
                    greenhouseId: response.data.greenhouseId,

                    submitted: true
                });
                console.log(response.data);
            })
            .catch(e => {
                console.log(e);
            });
    }

    newUser() {
        const { user } = this.props.auth0;

        this.setState({
            email: "",
            greenhouseId: user.greenhouse,

            submitted: false
        });
    }

    render() {
        return (
            <div className="submit-form">
                {this.state.submitted ? (
                    <div>
                        <h4>Your family member has been added successfully! They should receive an invite momentarily.</h4>
                        <button className="btn btn-success" onClick={this.newUser}>
                            Add more family
                        </button>
                    </div>
                ) : (
                    <div>
                        <div className="form-group">
                            <label htmlFor="Email">Email Address</label>
                            <input
                                type="text"
                                className="form-control"
                                id="email"
                                required
                                value={this.state.email}
                                onChange={this.onChangeEmail}
                                name="Name"
                            />
                        </div>

                        <button onClick={this.saveUser} className="btn btn-success">
                            Submit
                        </button>
                    </div>
                )}
            </div>
        );
    }
}

export default withAuth0(AddUser)