import React, { Component } from "react";
import PlantDataService from "../../services/plant.service";
import { Link } from "react-router-dom";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {useAuth0, withAuth0} from "@auth0/auth0-react";

export class PlantsList extends Component {
    constructor(props) {
        super(props);
        this.onChangeSearchName = this.onChangeSearchName.bind(this);
        this.retrieveUsers = this.retrieveUsers.bind(this);
        this.refreshList = this.refreshList.bind(this);
        this.setActiveUser = this.setActiveUser.bind(this);
        this.removeAllUsers = this.removeAllUsers.bind(this);
        this.searchName = this.searchName.bind(this);
        this.searchGreenhouseId = this.searchGreenhouseId.bind(this);

        const { user } = this.props.auth0;
        this.state = {
            greenhouseId: user.greenhouse,
            users: [],
            currentUser: null,
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
        PlantDataService.findByUserId(this.state.userId)
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

        PlantDataService.findByName(this.state.userId, this.state.searchName)
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

    searchUserId() {
        this.setState({
            currentPlant: null,
            currentIndex: -1
        });
        // console.log(this.state.userId);
        PlantDataService.findByUserId(this.state.userId)
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
                            href="/add"
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