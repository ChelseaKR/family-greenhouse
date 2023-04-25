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

    render() {
        const { searchName, plants, currentPlant, currentIndex } = this.state;

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
                    <h4>Plants List
                    <a
                        className="btn btn-sm btn-success" style={{float: "right"}}
                        href="/plants/add"
                    >
                        <FontAwesomeIcon icon="plus" className="mr-1" /> New Plant!
                    </a></h4>
                    <ul className="list-group">
                        {plants && plants.map((plant, index) => (
                                <li
                                    className={ "list-group-item " +  (index === currentIndex ? "active" : "")  }
                                    onClick={() => this.setActivePlant(plant, index)}
                                    key={index}
                                >
                                    {plant.name}
                                    <br></br>

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