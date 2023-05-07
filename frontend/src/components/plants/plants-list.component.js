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
    const [userId, setUserId] = useState(user.sub);
    const [greenhouse, setGreenhouse] = useState(user.greenhouse);
    const [plants, setPlants] = useState([]);
    const [currentPlant, setCurrentPlant] = useState(null);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [searchName, setSearchName] = useState("");

    const retrievePlants = useCallback(() => {
        PlantDataService.findByGreenhouse(greenhouse)
            .then((response) => {
                setPlants(response.data);
                console.log(response.data);
            })
            .catch((e) => {
                console.log(e);
            });
    }, [greenhouse]);

    useEffect(() => {
        retrievePlants();
    }, [retrievePlants]);

    const onChangeSearchName = (e) => {
        setSearchName(e.target.value);
    };

    const searchNameFn = () => {
        setCurrentPlant(null);
        setCurrentIndex(-1);

        PlantDataService.findByName(greenhouse, searchName)
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
        <div className="list row">
            <div className="col-md-12">
                <SearchBar value={searchName} onChange={onChangeSearchName} onSearch={searchNameFn} />
            </div>
            <div className="col-md-12">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h3>Plants List</h3>
                    <div>
                        <SortDropdown onChange={handleSortChange} />
                        <Link className="btn btn-sm btn-success" to="/plants/add">
                            <FontAwesomeIcon icon="plus" className="mr-1" /> New Plant!
                        </Link>
                    </div>
                </div>

                <ul className="list-group">
                    {plants &&
                        plants.map((plant, index) => (
                            <PlantsListItem
                                key={plant.id}
                                plant={plant}
                                index={index}
                                currentIndex={currentIndex}
                                onSetActive={setActivePlant}
                            />
                        ))}
                </ul>
            </div>
        </div>
    );
};

export default withAuth0(PlantsList);