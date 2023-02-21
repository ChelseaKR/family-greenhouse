import React, { Component } from "react";
import PlantDataService from "../../services/plant.service";
import { withRouter } from '../common/with-router';

class Plant extends Component {
    constructor(props) {
        super(props);
        this.onChangeName = this.onChangeName.bind(this);
        this.onChangeType = this.onChangeType.bind(this);
        this.onChangeLocation = this.onChangeLocation.bind(this);
        this.onChangeDescription = this.onChangeDescription.bind(this);
        this.getPlant = this.getPlant.bind(this);
        this.updatePlant = this.updatePlant.bind(this);
        this.deletePlant = this.deletePlant.bind(this);

        this.state = {
            currentPlant: {
                id: null,
                name: "",
                type: "",
                location: "",
                description: "",
            },
            message: ""
        };
    }

    componentDidMount() {
        this.getPlant(this.props.router.params.id);
    }

    onChangeName(e) {
        const name = e.target.value;

        this.setState(function(prevState) {
            return {
                currentPlant: {
                    ...prevState.currentPlant,
                    name: name
                }
            };
        });
    }

    onChangeType(e) {
        const type = e.target.value;

        this.setState(function(prevState) {
            return {
                currentPlant: {
                    ...prevState.currentPlant,
                    type: type
                }
            };
        });
    }

    onChangeLocation(e) {
        const location = e.target.value;

        this.setState(function(prevState) {
            return {
                currentPlant: {
                    ...prevState.currentPlant,
                    location: location
                }
            };
        });
    }

    onChangeDescription(e) {
        const description = e.target.value;

        this.setState(prevState => ({
            currentPlant: {
                ...prevState.currentPlant,
                description: description
            }
        }));
    }

    getPlant(id) {
        PlantDataService.get(id)
            .then(response => {
                this.setState({
                    currentPlant: response.data
                });
                console.log(response.data);
            })
            .catch(e => {
                console.log(e);
            });
    }

    updatePlant() {
        PlantDataService.update(
            this.state.currentPlant.id,
            this.state.currentPlant
        )
            .then(response => {
                console.log(response.data);
                this.setState({
                    message: "The plant's info was updated successfully!"
                });
            })
            .catch(e => {
                console.log(e);
            });
    }

    deletePlant() {
        PlantDataService.delete(this.state.currentPlant.id)
            .then(response => {
                console.log(response.data);
                this.props.router.navigate('/plants');
            })
            .catch(e => {
                console.log(e);
            });
    }

    render() {
        const { currentPlant } = this.state;

        return (
            <div>
                {currentPlant ? (
                    <div className="edit-form">
                        <h4>Plant</h4>
                        <form>
                            <div className="form-group">
                                <label htmlFor="name">Name</label>
                                <input
                                    type="text"
                                    className="form-control"
                                    id="name"
                                    value={currentPlant.name}
                                    onChange={this.onChangeName}
                                />
                            </div>
                            <div className="form-group">
                                <label htmlFor="type">Type</label>
                                <input
                                    type="text"
                                    className="form-control"
                                    id="type"
                                    value={currentPlant.type}
                                    onChange={this.onChangeType}
                                />
                            </div>
                            <div className="form-group">
                                <label htmlFor="location">Location</label>
                                <input
                                    type="text"
                                    className="form-control"
                                    id="location"
                                    value={currentPlant.location}
                                    onChange={this.onChangeLocation}
                                />
                            </div>
                            <div className="form-group">
                                <label htmlFor="description">Description</label>
                                <input
                                    type="text"
                                    className="form-control"
                                    id="description"
                                    value={currentPlant.description}
                                    onChange={this.onChangeDescription}
                                />
                            </div>
                        </form>

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