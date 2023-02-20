import http from "../http-common";

class PlantDataService {
    getAll() {
        return http.get("/plants");
    }

    get(id) {
        return http.get(`/plants/${id}`);
    }

    create(data) {
        return http.post("/plants/add", data);
    }

    update(id, data) {
        return http.put(`/plants/${id}`, data);
    }

    delete(id) {
        return http.delete(`/plants/${id}`);
    }

    deleteAll() {
        return http.delete(`/plants`);
    }

    findByName(name, data) {
        return http.get(`/plants?name=${name}`, data);
    }
}

export default new PlantDataService();