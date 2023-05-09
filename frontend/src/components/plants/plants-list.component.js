import React, { useState, useEffect, useCallback } from "react";
import PlantDataService from "../../services/plant.service";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { withAuth0 } from "@auth0/auth0-react";
import SearchBar from "./search-bar";
import SortDropdown from "./sort-dropdown";
import PlantsListItem from "./plants-list-item";

const PlantsList = ({ auth0 }) => {
    const { user } = auth0;
    const [greenhouse, setGreenhouse] = useState(user.greenhouse);
    const [plants, setPlants] = useState([]);
    const [currentPlant, setCurrentPlant] = useState(null);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [searchName, setSearchName] = useState("");
    const [loading, setLoading] = useState(true);

    const retrievePlants = useCallback(() => {
        setLoading(true);
        PlantDataService.findByGreenhouse(greenhouse)
            .then((response) => {
                setPlants(response.data);
                setLoading(false);
            })
            .catch((e) => {
                console.log(e);
                setLoading(false);
            });
    }, [greenhouse]);


    useEffect(() => {
        retrievePlants();
    }, [retrievePlants]);

    const onChangeSearchName = (value) => {
        setSearchName(value);
        searchNameFn(value);
    };

    const searchNameFn = (searchValue) => {
        setCurrentPlant(null);
        setCurrentIndex(-1);

        PlantDataService.findByName(greenhouse, searchValue)
            .then((response) => {
                setPlants(response.data);
                console.log(response.data);
            })
            .catch((e) => {
                console.log(e);
            });
    };

    const setActivePlant = (plant, index) => {
        setCurrentPlant(plant);
        setCurrentIndex(index);
    };

    const handleSortChange = (e) => {
        const selectedOption = e.target.value;
        const [property, order] = selectedOption.split("_");

        if (property && order) {
            const sortedPlants = [...plants].sort((a, b) => {
                if (a[property] < b[property]) return order === "asc" ? -1 : 1;
                if (a[property] > b[property]) return order === "asc" ? 1 : -1;
                return 0;
            });

            setPlants(sortedPlants);
        }
    };

    return (
        <div>
            <div className="list row">
                <div className="col-md-12"><h3>Plants List</h3></div></div>

                <div className="list row" style={{ alignItems: "baseline", justifyContent: "space-between" }}>
                <div className="col-md-6">
                    <SearchBar value={searchName} onChange={onChangeSearchName} />
                </div>
                <div className="col-xs-3">
                    <SortDropdown onChange={handleSortChange} />
                </div>
                <div className="col-xs-3">
                    <Link className="btn btn-success" to="/plants/add">
                        <FontAwesomeIcon icon="plus" className="mr-1" /> New Plant!
                    </Link>
                </div>
            </div>
            {loading ? (
                <p>Loading...</p>
            ) : plants.length === 0 ? (
                <li className="list-group">
                    <li className="list-group-item">No plants yet. Add some to get started!</li>
                </li>
            ) : (
                plants.map((plant, index) => (
                    <PlantsListItem
                        key={plant.id}
                        plant={plant}
                        index={index}
                        currentIndex={currentIndex}
                        onSetActive={setActivePlant}
                    />
                ))
            )}
        </div>
    );
};

export default withAuth0(PlantsList);