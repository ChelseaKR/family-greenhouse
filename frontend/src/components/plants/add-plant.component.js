import React, { Component } from "react";
import PlantDataService from "../../services/plant.service";
import { withAuth0 } from '@auth0/auth0-react';

class AddPlant extends Component {
    constructor(props) {
        super(props);
        this.onChangeName = this.onChangeName.bind(this);
        this.onChangeType = this.onChangeType.bind(this);
        this.onChangeLocation = this.onChangeLocation.bind(this);
        this.onChangeDescription = this.onChangeDescription.bind(this);
        this.savePlant = this.savePlant.bind(this);
        this.newPlant = this.newPlant.bind(this);

        const { user } = this.props.auth0;
        console.log(JSON.stringify(user));
        this.state = {
            userId: user.sub,
            id: "",
            name: "",
            type: "",
            location: "",
            description: "",

            submitted: false
        };
    }

    onChangeName(e) {
        this.setState({
            name: e.target.value
        });
    }

    onChangeType(e) {
        this.setState({
            type: e.target.value
        });
    }

    onChangeLocation(e) {
        this.setState({
            location: e.target.value
        });
    }

    onChangeDescription(e) {
        this.setState({
            description: e.target.value
        });
    }

    savePlant() {
        var data = {
            userId: this.state.userId,
            name: this.state.name,
            type: this.state.type,
            location: this.state.location,
            description: this.state.description
        };

        PlantDataService.create(data)
            .then(response => {
                this.setState({
                    id: response.data.id,
                    name: response.data.name,
                    type: response.data.type,
                    location: response.data.location,
                    description: response.data.description,

                    submitted: true
                });
                console.log(response.data);
            })
            .catch(e => {
                console.log(e);
            });
    }

    newPlant() {
        this.setState({
            id: null,
            name: "",
            type: "",
            location: "",
            description: "",

            submitted: false
        });
    }

    render() {
        return (
            <div className="submit-form">
                {this.state.submitted ? (
                    <div>
                        <h4>Your plant has been added successfully!</h4>
                        <button className="btn btn-success" onClick={this.newPlant}>
                            Add
                        </button>
                    </div>
                ) : (
                    <div>
                        <div className="form-group">
                            <label htmlFor="Name">Name</label>
                            <input
                                type="text"
                                className="form-control"
                                id="name"
                                required
                                value={this.state.name}
                                onChange={this.onChangeName}
                                name="Name"
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="Type">Type</label>
                            <input
                                type="text"
                                className="form-control"
                                id="type"
                                required
                                value={this.state.type}
                                onChange={this.onChangeType}
                                name="Type"
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="Location">Location</label>
                            <input
                                type="text"
                                className="form-control"
                                id="type"
                                required
                                value={this.state.location}
                                onChange={this.onChangeLocation}
                                name="Location"
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="Description">Description</label>
                            <input
                                type="text"
                                className="form-control"
                                id="description"
                                required
                                value={this.state.description}
                                onChange={this.onChangeDescription}
                                name="description"
                            />
                        </div>

                        <button onClick={this.savePlant} className="btn btn-success">
                            Submit
                        </button>
                    </div>
                )}
            </div>
        );
    }
}

export default withAuth0(AddPlant)