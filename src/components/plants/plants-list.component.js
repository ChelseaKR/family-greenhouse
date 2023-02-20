import React, { Component } from "react";
import PlantDataService from "../../services/plant.service";
import { Link } from "react-router-dom";

export default class PlantsList extends Component {
    constructor(props) {
        super(props);
        this.onChangeSearchName = this.onChangeSearchName.bind(this);
        this.retrievePlants = this.retrievePlants.bind(this);
        this.refreshList = this.refreshList.bind(this);
        this.setActivePlant = this.setActivePlant.bind(this);
        this.removeAllPlants = this.removeAllPlants.bind(this);
        this.searchName = this.searchName.bind(this);

        this.state = {
            plants: [],
            currentPlant: null,
            currentIndex: -1,
            searchName: ""
        };
    }

    componentDidMount() {
        this.retrievePlants();
    }

    onChangeSearchName(e) {
        const searchName = e.target.value;

        this.setState({
            searchName: searchName
        });
    }

    retrievePlants() {
        PlantDataService.getAll()
            .then(response => {
                this.setState({
                    plants: response.data
                });
                console.log(response.data);
            })
            .catch(e => {
                console.log(e);
            });
    }

    refreshList() {
        this.retrievePlants();
        this.setState({
            currentPlant: null,
            currentIndex: -1
        });
    }

    setActivePlant(plant, index) {
        this.setState({
            currentPlant: plant,
            currentIndex: index
        });
    }

    removeAllPlants() {
        PlantDataService.deleteAll()
            .then(response => {
                console.log(response.data);
                this.refreshList();
            })
            .catch(e => {
                console.log(e);
            });
    }

    searchName() {
        this.setState({
            currentPlant: null,
            currentIndex: -1
        });

        PlantDataService.findByName(this.state.searchName)
            .then(response => {
                this.setState({
                    plants: response.data
                });
                console.log(response.data);
            })
            .catch(e => {
                console.log(e);
            });
    }

    render() {
        const { searchName, plants, currentPlant, currentIndex } = this.state;

        return (
            <div className="list row">
                <div className="col-md-8">
                    <div className="input-group mb-3">
                        <input
                            type="text"
                            className="form-control"
                            placeholder="Search by name"
                            value={searchName}
                            onChange={this.onChangeSearchName}
                        />
                        <div className="input-group-append">
                            <button
                                className="btn btn-outline-secondary"
                                type="button"
                                onClick={this.searchName}
                            >
                                Search
                            </button>
                        </div>
                    </div>
                </div>
                <div className="col-md-6">
                    <h4>Plants List</h4>

                    <ul className="list-group">
                        {plants &&
                            plants.map((plant, index) => (
                                <li
                                    className={
                                        "list-group-item " +
                                        (index === currentIndex ? "active" : "")
                                    }
                                    onClick={() => this.setActivePlant(plant, index)}
                                    key={index}
                                >
                                    {plant.name}
                                </li>
                            ))}
                    </ul>

                    <button
                        className="m-3 btn btn-sm btn-danger"
                        onClick={this.removeAllPlants}
                    >
                        Remove All
                    </button>
                </div>
                <div className="col-md-6">
                    {currentPlant ? (
                        <div>
                            <h4>Plant</h4>
                            <div>
                                <label>
                                    <strong>Name:</strong>
                                </label>{" "}
                                {currentPlant.name}
                            </div>
                            <div>
                                <label>
                                    <strong>Type:</strong>
                                </label>{" "}
                                {currentPlant.type}
                            </div>
                            <div>
                                <label>
                                    <strong>Location:</strong>
                                </label>{" "}
                                {currentPlant.location}
                            </div>
                            <div>
                                <label>
                                    <strong>Description:</strong>
                                </label>{" "}
                                {currentPlant.description}
                            </div>

                            <Link
                                to={"/plants/" + currentPlant.id}
                                className="badge badge-warning"
                            >
                                Edit
                            </Link>
                        </div>
                    ) : (
                        <div>
                            <br />
                            <p>Select a plant</p>
                        </div>
                    )}
                </div>
            </div>
        );
    }
}
