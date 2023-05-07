import React, { Component } from "react";
import PlantDataService from "../../services/plant.service";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { withAuth0 } from "@auth0/auth0-react";

export class PlantsList extends Component {
    constructor(props) {
        super(props);
        this.onChangeSearchName = this.onChangeSearchName.bind(this);
        this.retrievePlants = this.retrievePlants.bind(this);
        this.refreshList = this.refreshList.bind(this);
        this.setActivePlant = this.setActivePlant.bind(this);
        this.removeAllPlants = this.removeAllPlants.bind(this);
        this.searchName = this.searchName.bind(this);
        this.searchGreenhouse = this.searchGreenhouse.bind(this);
        this.handleSortChange = this.handleSortChange.bind(this);

        const { user } = this.props.auth0;

        this.state = {
            userId: user.sub,
            greenhouse: user.greenhouse,
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
        PlantDataService.findByGreenhouse(this.state.greenhouse)
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

        PlantDataService.findByName(this.state.greenhouse, this.state.searchGreenhouse)
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

    searchGreenhouse() {
        this.setState({
            currentPlant: null,
            currentIndex: -1
        });
        // console.log(this.state.userId);
        console.log(this.state.greenhouse);
        PlantDataService.findByGreenhouse(this.state.greenhouse)
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

    sortPlants(property, order) {
        const sortedPlants = this.state.plants.sort((a, b) => {
            if (a[property] < b[property]) return order === "asc" ? -1 : 1;
            if (a[property] > b[property]) return order === "asc" ? 1 : -1;
            return 0;
        });

        this.setState({
            plants: sortedPlants
        });
    }

    handleSortChange(e) {
        const selectedOption = e.target.value;
        const [property, order] = selectedOption.split("_");

        if (property && order) {
            this.sortPlants(property, order);
        }
    }

    render() {
        const { searchName, plants, currentIndex } = this.state;

        return (
            <div className="list row">
                <div className="col-md-12">
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
                <div className="col-md-12">
                    <div style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}>
                        <h3>Plants List</h3>
                        <div>
                            <div style={{display: "inline-block", marginRight: "2em"}}>
                                Sort by:
                                <select className="custom-select custom-select-sm custom-dropdown ml-2" onChange={e => this.handleSortChange(e)}>
                                    <option value="">Select</option>
                                    <option value="name_asc">Name (A-Z)</option>
                                    <option value="name_desc">Name (Z-A)</option>
                                    <option value="type_asc">Type (A-Z)</option>
                                    <option value="type_desc">Type (Z-A)</option>
                                    <option value="location_asc">Location (A-Z)</option>
                                    <option value="location_desc">Location (Z-A)</option>
                                </select>
                            </div>
                            <a
                                className="btn btn-sm btn-success"
                                href="/plants/add"
                            >
                                <FontAwesomeIcon icon="plus" className="mr-1" /> New Plant!
                            </a>
                        </div>
                    </div>

                    <ul className="list-group">
                        {plants && plants.map((plant, index) => (
                                <li
                                    className={ "list-group-item " +  (index === currentIndex ? "active" : "")  }
                                    onClick={() => this.setActivePlant(plant, index)}
                                    key={index}
                                >
                                    <h4>{plant.name}</h4>
                                    <div>{plant.type} {plant.type && plant.location ? '•' : ''} {plant.location}</div>
                                    <Link
                                        to={"/plants/" + plant.id}
                                        className="badge badge-warning"
                                    >
                                        Edit
                                    </Link>
                                </li>
                            ))}
                    </ul>
{/*                    <button
                        className="m-3 btn btn-sm btn-danger"
                        onClick={this.removeAllPlants}
                    >
                        Remove All
                    </button>*/}
                </div>
            </div>
        );
    }
}

export default withAuth0(PlantsList)