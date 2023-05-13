import React, { useState, useEffect } from "react";
import PlantDataService from "../../services/plant.service";
import { withRouter } from "../common/with-router";

const Plant = ({ router }) => {
    const [currentPlant, setCurrentPlant] = useState({
        id: null,
        greenhouse: "",
        name: "",
        type: "",
        location: "",
        description: "",
        water_frequency_days: 0,
        water_reminder_time: null,
    });

    const [currentTask, setCurrentTask] = useState({
        task_type: 'water',
        next_task_date: null,
    });

    const [message, setMessage] = useState("");

    useEffect(() => {
        getPlant(router.params.id);
    }, [router.params.id]);

    const getPlant = (id) => {
        PlantDataService.get(id)
            .then(response => {
                setCurrentPlant(response.data);
                console.log(response.data);
            })
            .catch(e => {
                console.log(e);
            });
    }

    const updatePlant = () => {
        PlantDataService.update(
            currentPlant.id,
            currentPlant,
            currentTask
        )
            .then(response => {
                console.log(response.data);
                setMessage("The plant's info was updated successfully!");
            })
            .catch(e => {
                console.log(e);
            });
    }

    const deletePlant = () => {
        PlantDataService.delete(currentPlant.id)
            .then(response => {
                console.log(response.data);
                router.navigate('/plants');
            })
            .catch(e => {
                console.log(e);
            });
    }

    const onChange = (field) => (e) => {
        setCurrentPlant({
            ...currentPlant,
            [field]: e.target.value,
        });
    }

    const daysOptions = Array.from({ length: 365 }, (_, i) => { return i + 1; });
    const hoursOptions = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, "0")}:00:00`);

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
                                onChange={onChange('name')}
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="type">Type</label>
                            <input
                                type="text"
                                className="form-control"
                                id="type"
                                value={currentPlant.type}
                                onChange={onChange('type')}
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="location">Location</label>
                            <input
                                type="text"
                                className="form-control"
                                id="location"
                                value={currentPlant.location}
                                onChange={onChange('location')}
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="description">Description</label>
                            <input
                                type="text"
                                className="form-control"
                                id="description"
                                value={currentPlant.description}
                                onChange={onChange('description')}
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor={`days-water`}>Remind me to water:</label>
                            <select id="days" value={currentPlant.water_frequency_days} onChange={onChange('water_frequency_days')}>
                                <option value="">Select an option</option>
                                {daysOptions.map((option) => (
                                    <option key={option} value={option}>
                                        Every {option} {option > 1 ? 'days' : 'day'}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="form-group">
                            <label htmlFor="water-reminder-time">Water Reminder Time:</label>
                            <select id="time" value={currentPlant.water_reminder_time} onChange={onChange('water_reminder_time')}>
                                <option value="">Select an option (Pacific Time)</option>
                                {hoursOptions.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </form>

                    <button
                        className="badge badge-danger mr-2"
                        onClick={deletePlant}
                    >
                        Delete
                    </button>

                    <button
                        type="submit"
                        className="badge badge-success"
                        onClick={updatePlant}
                    >
                        Update
                    </button>
                    <p>{message}</p>
                </div>
            ) : (
                <div>
                    <br />
                    <p>Please select a plant...</p>
                </div>
            )}
        </div>
    );
}

export default withRouter(Plant);