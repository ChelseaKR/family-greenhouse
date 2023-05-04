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
        this.onChangeTaskFrequencyDays = this.onChangeTaskFrequencyDays.bind(this);
        this.savePlant = this.savePlant.bind(this);
        this.newPlant = this.newPlant.bind(this);

        const { user } = this.props.auth0;
        console.log(JSON.stringify(user));
        this.state = {
            newPlant: {
                userId: user.sub,
                greenhouse: user.greenhouse,
                id: "",
                name: "",
                type: "",
                location: "",
                description: "",
            },
            newTask: {
                task_type: 'water',
                reminder_time: null,
                next_task_date: null,
                task_frequency_days: 0
            },
            selectedWaterFrequencyOption: "",
            submitted: false
        };
    }

    onChangeName(e) {
        const name = e.target.value;

        this.setState(function(prevState) {
            return {
                newPlant: {
                    ...prevState.newPlant,
                    name: name
                }
            };
        });
    }

    onChangeType(e) {
        const type = e.target.value;

        this.setState(function(prevState) {
            return {
                newPlant: {
                    ...prevState.newPlant,
                    type: type
                }
            };
        });
    }

    onChangeLocation(e) {
        const location = e.target.value;

        this.setState(function(prevState) {
            return {
                newPlant: {
                    ...prevState.newPlant,
                    location: location
                }
            };
        });
    }

    onChangeDescription(e) {
        const description = e.target.value;

        this.setState(prevState => ({
            newPlant: {
                ...prevState.newPlant,
                description: description
            }
        }));
    }

    onChangeTaskFrequencyDays(e) {
        const taskFrequencyDays = e.target.value;

        this.setState(prevState => ({
            newTask: {
                ...prevState.newTask,
                task_frequency_days: taskFrequencyDays
            }
        }));
    }

    onChangeTaskTime(e) {
        const reminderTime = e.target.value;

        this.setState(prevState => ({
            newTask: {
                ...prevState.newTask,
                reminder_time: reminderTime
            }
        }));
    }

    savePlant() {
        const { user } = this.props.auth0;

        var data = {
            userId: this.state.newPlant.userId,
            greenhouse: user.greenhouse,
            name: this.state.newPlant.name,
            type: this.state.newPlant.type,
            location: this.state.newPlant.location,
            description: this.state.newPlant.description,
            task_frequency_days: this.state.newTask.task_frequency_days,
            taskTime: this.state.newTask.reminder_time
        };

        PlantDataService.create(data)
            .then(response => {
                console.log("creating plant in greenhouse: " + user.greenhouse);
                this.setState({
                    newPlant: {
                        id: response.data.id,
                        greenhouse: user.greenhouse,
                        name: response.data.name,
                        type: response.data.type,
                        location: response.data.location,
                        description: response.data.description,
                    },
                    newTask: {
                        plant_id: response.data.id,
                        task_type: response.data.task_type,
                        task_frequency_days: response.data.task_frequency_days,
                        next_task_date: response.data.next_task_date,
                        reminder_time: response.data.reminder_time,
                    },
                    selectedWateringFrequencyOption: "",

                    submitted: true
                });
                console.log(response.data);
            })
            .catch(e => {
                console.log(e);
            });
    }

    newPlant() {
        const { user } = this.props.auth0;
        this.setState({
            newPlant: {
                id: null,
                userId: user.sub,
                greenhouse: user.greenhouse,
                name: "",
                type: "",
                location: "",
                description: "",
            },
            newTask: {
                id: null,
                plant_id: null,
                task_type: 'water',
                reminder_time: null,
                next_task_date: null,
            },
            selectedWateringFrequencyOption: "",

            submitted: false
        });
    }

    render() {
        const daysOptions = Array.from({ length: 365 }, (_, i) => {
            return i + 1;
        });
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
                                value={this.state.newPlant.name}
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
                                value={this.state.newPlant.type}
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
                                value={this.state.newPlant.location}
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
                                value={this.state.newPlant.description}
                                onChange={this.onChangeDescription}
                                name="description"
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor={`days-watering`}>Remind me to water:</label>
                            <select id="days" value={this.state.newPlant.task_frequency_days} onChange={this.onChangeTaskFrequencyDays}>
                                <option value="">Select an option</option>
                                {daysOptions.map((option) => (
                                    <option key={option} value={option}>
                                        Every {option} {option > 1 ? 'days' : 'day'}
                                    </option>
                                ))}
                            </select>
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