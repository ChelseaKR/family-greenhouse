import React, { useState, useEffect, useCallback } from "react";
import PlantDataService from "../../services/plant.service";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { withAuth0 } from "@auth0/auth0-react";

const PlantsList = ({ auth0 }) => {
    const { user } = auth0;
    const [state, setState] = useState({
        userId: user.sub,
        greenhouse: user.greenhouse,
        plants: [],
        currentPlant: null,
        currentIndex: -1,
        searchName: ""
    });

    const { searchName, plants, currentIndex } = state;

    const retrievePlants = useCallback(() => {
        PlantDataService.findByGreenhouse(state.greenhouse)
            .then(response => {
                setState(prevState => ({ ...prevState, plants: response.data }));
            })
            .catch(e => {
                console.log(e);
            });
    }, [state.greenhouse]);

    useEffect(() => {
        retrievePlants();
    }, [retrievePlants]);

    const onChangeSearchName = e => {
        const searchName = e.target.value;
        setState(prevState => ({ ...prevState, searchName }));
    };

    const refreshList = () => {
        retrievePlants();
        setState(prevState => ({
            ...prevState,
            currentPlant: null,
            currentIndex: -1
        }));
    };

    const setActivePlant = (plant, index) => {
        setState(prevState => ({
            ...prevState,
            currentPlant: plant,
            currentIndex: index
        }));
    };

    const removeAllPlants = () => {
        PlantDataService.deleteAll()
            .then(response => {
                refreshList();
            })
            .catch(e => {
                console.log(e);
            });
    };

    const searchNameFn = () => {
        setState(prevState => ({
            ...prevState,
            currentPlant: null,
            currentIndex: -1
        }));

        PlantDataService.findByName(state.greenhouse, state.searchName)
            .then(response => {
                setState(prevState => ({ ...prevState, plants: response.data }));
            })
            .catch(e => {
                console.log(e);
            });
    };

    const sortPlants = useCallback((property, order) => {
        const sortedPlants = state.plants.sort((a, b) => {
            if (a[property] < b[property]) return order === "asc" ? -1 : 1;
            if (a[property] > b[property]) return order === "asc" ? 1 : -1;
            return 0;
        });

        setState(prevState => ({ ...prevState, plants: sortedPlants }));
    }, [state.plants]);

    const handleSortChange = e => {
        const selectedOption = e.target.value;
        const [property, order] = selectedOption.split("_");

        if (property && order) {
            sortPlants(property, order);
        }
    };

    return (
        <div className="list row">
            <div className="col-md-12">
                <div className="input-group mb-3">
                    <input
                        type="text"
                        className="form-control"
                        placeholder="Search by name"
                        value={searchName}
                        onChange={onChangeSearchName}
                    />
                    <div className="input-group-append">
                        <button
                            className="btn btn-outline-secondary"
                            type="button"
                            onClick={searchNameFn}
                        >
                            Search
                        </button>
                    </div>
                </div>
            </div>
            <div className="col-md-12">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h3>Plants List</h3>
                    <div>
                        <div style={{ display: "inline-block", marginRight: "2em" }}>
                            Sort by:
                            <select className="custom-select custom-select-sm custom-dropdown ml-2" onChange={handleSortChange}>
                                <option value="">Select</option>
                                <option value="name_asc">Name (A-Z)</option>
                                <option value="name_desc">Name (Z-A)</option>
                                <option value="type_asc">Type (A-Z)</option>
                                <option value="type_desc">Type (Z-A)</option>
                                <option value="location_asc">Location (A-Z)</option>
                                <option value="location_desc">Location (Z-A)</option>
                            </select>
                        </div>
                        <Link
                            className="btn btn-sm btn-success"
                            to="/plants/add"
                        >
                            <FontAwesomeIcon icon="plus" className="mr-1" /> New Plant!
                        </Link>
                    </div>
                </div>

                <ul className="list-group">
                    {plants && plants.map((plant, index) => (
                        <li
                            className={"list-group-item " + (index === currentIndex ? "active" : "")}
                            onClick={() => setActivePlant(plant, index)}
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
            </div>
        </div>
    );
};

export default withAuth0(PlantsList);